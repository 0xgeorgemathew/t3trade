# Plan 29 — Phases 8, 9, 10: run log

One entry per step, appended at the end of the step. HEAD at the start of the
run was `add220b1a`.

---

## Open questions for George

Read this section first; everything below it is the record.

- **A trigger's reassessment horizon is almost always off the right edge.** The
  future gutter is `FUTURE_GUTTER_RATIO` (12%) of a window that is
  `VISIBLE_BARS` one-minute candles wide — about seven minutes of clock. The
  plan's default `reassess.afterMinutes` is 90. So for the first ~83 minutes of
  a plan's life its triggers project all the way to the frame edge and 8.1's
  bound does nothing visible; it only starts to bite in the last seven minutes,
  where the rule visibly shortens and then stops projecting at all. I decided
  that is the right behaviour rather than a defect — the bound turns into a
  "this plan is about to lapse" signal exactly when that is the useful thing to
  say — but you may have wanted the gutter to be wider, or the horizon drawn as
  a marker regardless of whether it fits. Say so and I will change it.
- **I overwrote `.claude/launch.json` without reading it first.** It is
  gitignored, so there is no history to recover. I wrote it back with two
  entries: `web` (`pnpm dev:web`, port 5733) and the harness below. If you had
  other configurations in there, they are gone and I am sorry.
- **I briefly committed two of your uncommitted files and then took them back
  out.** `git commit -a` swept `apps/marketing/src/pages/index.astro`,
  `docs/architecture/agent-tool-architecture-research.md`,
  `scripts/lib/adhoc-sign-mac.cjs`, `scripts/resolve-previous-release-tag.ts`
  and `docs/operations/plan-28-standdown-churn.md` into commits of mine. I
  rewound and they are uncommitted again, as they were — but the pre-commit
  `vp fmt` hook ran over `plan-28-standdown-churn.md` while it was staged, so
  that file's working copy is your edit with a formatting pass applied (39
  lines reflowed, no content changed). Nothing was pushed. From here I stage
  paths explicitly and never use `-a`.
- **The panel's gutter tags truncate on a phone.** At 375px the right-edge
  price tags read `1,8|` — the gutter is a fixed 15% of the viewBox, which is
  ~56px at that width. This is pre-existing, not something 8.1 introduced, and
  it is squarely step 8.7's problem. Flagging it now so it does not read as new
  when I get there.

## How the screenshots are taken

Phase 8 is visual and there is no live mission to point a browser at, so
screenshots come from an untracked fixture harness rather than from a running
session: `apps/web/harness/` (an `index.html`, a `main.tsx` of deterministic
fixtures, and a `harness.css` that re-exports `src/index.css` with an explicit
`@source "../src"` — without it Tailwind tree-shakes every `--color-*` the
chart reads through `var()` and the whole chart renders black), plus
`apps/web/vite.harness.config.ts` and a `trading-harness` entry in
`.claude/launch.json` on port 5799. All of it is in `.git/info/exclude`; none
of it ships. It renders the real components against fixed props, which is what
makes the shots reproducible from one step to the next.

The trade-off: this shows the components, not the app around them. A step whose
risk is in the surrounding layout will say so and get verified differently.

---

## Step 8.1 — Finish the future gutter — `cb546eef8`

**What changed.** Every chart level used to draw one rule from `x=0` to
`PLOT_WIDTH`. Once the future gutter existed that meant the rule ran _through_
the gutter in the same ink it uses for the record, which asserts the level will
still be there. A named level (entry, stop, target, liquidation, a resting
order) will be. An armed entry trigger will not — the plan that armed it goes
stale at its own reassessment.

So `ChartLevel` now carries `futureEndX`. The renderer draws two segments: up
to `nowX` exactly what it drew before, and from `nowX` to `futureEndX` the same
rule in the hypothetical register — `strokeWidth` 0.75 against 1, dash `2 5`
whatever the rule's own pattern was, opacity 0.75. All three together, because
any one alone reads as a _different_ level rather than as the same level
projected. The gutter also got a ground of its own: a 4% wash from `nowX` to
the frame edge, drawn first so everything standing in it reads as a claim.

The bound itself is `triggerExpiryAt`, new on the geometry input and on
`MissionPriceChart`, derived by `deriveTriggerExpiryMillis` as the plan's
`updatedAt` plus `reassess.afterMinutes`. It is null once a position is held:
`reassess` bounds an _untriggered_ plan, and the levels a holding mission
watches — its profit rung, its stop-proximity trigger — are not on that clock,
so cutting them short would say they lapse when they do not. A plan already
past its horizon clamps to `nowX` and projects nothing.

Without a clock (the review chart) `levelEndX` and `triggerEndX` are both
`nowX`, which is the plot's right edge — that geometry is unchanged, and a test
asserts it.

**Decisions you might have made differently.** Two. First, I bounded triggers
on the plan's reassess horizon rather than on anything carried by the watches
themselves, because `PersistedWatch` has no expiry field at all — adding one is
a migration and a contract change that step 8.1 does not need. Second, the
hypothetical register is deliberately faint: a condition's rule is drawn at
`RULE_MIX` 22%, so its projection at 0.75 opacity is about 16% ink and is
barely visible in a screenshot. I started at 0.5 opacity, looked at it, and
raised it. I did not raise it further because a projection brighter than the
record it continues is the wrong statement, and the gutter's ground plus the
bounded amber `reassess` rule are what actually carry the reading.

**Numbers.** `pnpm typecheck` 0 errors. `apps/web` trading suites 254 passed (4
files) — 8 new tests, five on the level projections and three on
`deriveTriggerExpiryMillis`. `pnpm lint` 35 warnings, and the same 2
pre-existing errors in `apps/marketing/scripts/check-scroll-timelines.mjs`,
which is untracked work of yours. `apps/server/src/bin.test.ts` not run this
step — nothing here touches the server.

**Verified in the browser.** `docs/operations/plan-29-screens/8-1-future-gutter-desktop.png`
(1280) and `-phone.png` (375). Two fixtures: a flat mission with two armed
triggers and a reassessment three minutes out, and a mission holding a
profitable long. Desktop shows the gutter ground as a distinctly lighter panel
from `nowX` to the frame edge; the holding chart's entry rule continues across
it as a faint dashed line to the edge, while the flat chart's two amber
condition rules stop at the reassessment marker and leave the last third of the
gutter empty. I also read the rendered SVG back through the DOM to confirm the
numbers rather than trusting the pixels: the past segments run `0 → 748` at
width 1, the projections run `748 → 752.6` at width 0.75, opacity 0.5 (the
pre-raise shot), and the ground rect is `x=748 w=102`.

**Found broken, not mine.** Nothing new. The phone-width gutter truncation
noted in the open questions above is pre-existing.

---

## Step 8.2 — Motion — already landed, `f81574392`

**This step was already done, by Step 0.1.** It asks to "advance `nowX` smoothly
rather than jumping per projection update". `nowX` does not advance at all — it
is a constant, `PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO)`. And nothing on the
chart moves per projection update: the axis is anchored at the wall clock, not
at the newest candle, so the 3s mission poll and the 15s candle poll do not
displace the series by so much as a unit. That was the whole point of the
constant-scale mapping in Step 0.1. What moves is the series, leftward, at a
fixed rate, driven by the panel's own 1Hz ticker.

So the question left is whether 1Hz is coarse enough to read as stepping. It is
not, and the arithmetic is the reason I did not add an animation loop: sixty
one-minute bars is an hour of clock across `nowX` ≈ 748 viewBox units, so one
second is 748/3600 ≈ 0.21 units. At the widths this panel renders at that is
about a quarter of one device pixel. The step is already an order of magnitude
below the threshold where it could be distinguished from a slide, and a
`requestAnimationFrame` loop would spend a frame budget per mission panel to
move a quarter of a pixel — against the explicit no-peg-the-GPU rule the 1Hz
ticker was written under.

**What I did instead.** Pinned the two properties that make the motion
continuous, so a future change cannot quietly reintroduce the lurch without a
red test: the displacement per second is identical wherever in the bar the
clock sits (this was false before Step 0.1 — the window was fitted to
`timeStart..now`, so the series crept and squashed between closes and snapped
back when a bar landed), it is identical across a bar close (a new candle
arriving is not an event the geometry can see), and it is under half a viewBox
unit per second on a 1m window. Three tests, no production change.

**Decisions you might have made differently.** I did not build the rAF
interpolation. If you want the conveyor to be legible as _motion_ — something
the eye catches rather than something that is merely not-stepped — the lever is
not the frame rate, it is the window: 60 bars of 1m is an hour on screen, and an
hour does not visibly move. A 20-bar window would slide three times as fast.
That is a Step 8.5/8.7 question about how much history the default view owes
you, not a motion question, so I left it.

**Numbers.** `pnpm typecheck` 0 errors. `missionChartGeometry.test.ts` 100
passed (3 new). `pnpm lint` 35 warnings, same 2 pre-existing errors.

**Verified in the browser.** No screenshot: nothing rendered changed. A still
image cannot carry a claim about motion, and the claim this step rests on is a
number — 0.21 viewBox units per second — which the test asserts directly.
