import { defineConfig } from "astro/config";

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    build: {
      // The CSS minifier folds `animation-timeline` into the `animation`
      // shorthand, which no browser parses, so every scroll-driven animation
      // was silently dropped from the production build. See
      // scripts/check-scroll-timelines.mjs, which fails the build if it
      // regresses.
      cssMinify: false,
    },
  },
});
