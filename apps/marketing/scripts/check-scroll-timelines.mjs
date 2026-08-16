// The CSS minifier folds `animation-timeline` into the `animation` shorthand,
// which no browser parses, so scroll-driven animations vanish from a
// production build while dev keeps working. This guard fails the build if the
// built CSS loses its timelines or grows a folded shorthand.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/_astro/", import.meta.url).pathname;
const MIN_TIMELINES = 12;

const css = readdirSync(DIST)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(join(DIST, name), "utf8"))
  .join("\n");

const timelines = css.match(/animation-timeline\s*:/g)?.length ?? 0;
const folded = css.match(/animation\s*:[^;}]*\b(view|scroll)\(/g) ?? [];

const problems = [];
if (timelines < MIN_TIMELINES) {
  problems.push(
    `only ${timelines} animation-timeline declarations survived, expected at least ${MIN_TIMELINES}`,
  );
}
if (folded.length > 0) {
  problems.push(`animation shorthand swallowed a timeline: ${folded[0]}`);
}

if (problems.length > 0) {
  console.error("scroll timelines did not survive the build:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`scroll timelines ok (${timelines} declarations, none folded)`);
