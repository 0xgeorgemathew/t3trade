# T3 Trade UI — Design-Taste Scan

Date: 2026-08-17 · Method: `design-taste-frontend` skill, applied by three parallel read-only scans (trading cockpit, chat surfaces, global design foundation). Analysis only; no code changed.

**Design read:** dense product UI (trading cockpit embedded in a chat workspace) for an operator audience, with a restrained glass-and-hairline dark/light language built on Tailwind v4 semantic tokens.

**Scope note:** the skill itself declares dashboards and dense product UI out of scope for its landing-page rules (Section 13). Its universal parts were applied instead: typography discipline, color calibration, AI-tells, motion and reduced-motion, contrast, theme lock, performance guardrails.

**Dial reading of the existing UI** (Section 11.B — infer, don't impose):

| Dial             | Value | Evidence                                                                                                                           |
| ---------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DESIGN_VARIANCE  | 3–4   | Symmetric panes, but deliberate asymmetry: "two cards with air between them, not two halves of one box" (MissionLivePanel.tsx:635) |
| MOTION_INTENSITY | 2–3   | Only two infinite pulses (both guarded), one-shot draw-ins, no motion library                                                      |
| VISUAL_DENSITY   | 8–9   | Cockpit register: hairline dividers, mono figures, no decorative cards                                                             |

## What the scan found excellent

These are the skill's hard checks, and this UI passes them better than most marketing pages do:

1. **Color discipline.** Semantic tokens (`--profit`, `--loss`, `--long`, `--short`, `--armed`) instead of raw palette names, with matched lightness/chroma oklch pairs so green and red "weigh the same" (index.css:1037–1043). P&L sign and position side are deliberately separate tokens. No purple AI-slop, no decorative gradients, no pure `#000`/`#fff` in components. The one raw palette use (`amber-500` in MissionStalenessBanner.tsx:41) is a lone drift from the token system.
2. **Theme lock.** Chat and trading share one token system and one glass vocabulary; light zinc default and a `neutral-950` dark variant ride the same semantic roles (index.css:981–1136). It reads as one product, not two.
3. **Typography.** A documented doctrine: every figure in the mono face with `tabular-nums`, prose in the UI face (MissionLivePanel.tsx:46–51). System fonts only — zero webfont payload, consistent with the repo's perf doctrine. Negative tracking on the big figures.
4. **Motion and reduced motion.** Every loop has a `prefers-reduced-motion` guard; status-pulse keyframes are duty-cycled with `steps()` so the compositor updates discrete frames (index.css:146–147); pulses animate only opacity/scale; the chart's draw-in class is stripped after one play (MissionPriceChart.tsx:452). This is the skill's Section 6 checklist executed properly.
5. **States.** Empty states are designed, not defaulted: the position skeleton uses static dashes because "a shimmering bar in this cell read as a request stuck forever" (MissionLivePanel.tsx:1224), and the thread cards render nothing rather than placeholder rows because "a row of em-dashes reads as a broken feed." Staleness is a three-band state machine (quiet chip at 15s, banner at 45s, tradingPresentation.ts:788–859).
6. **Accessibility scaffolding.** `aria-hidden` on decorative glyphs, `aria-label` on tone dots, `role="slider"` with `aria-valuenow` on the draggable chart levels, focus-visible rings, and contrast decisions argued in comments (the 10px band legend is set in muted ink, not a fraction of it, "at 10px a 70%-opacity label is under the AA contrast floor").
7. **Performance posture.** Virtualized chat timeline (LegendList), explicit list caps with "+N earlier" instead of unbounded growth, grain texture baked per-surface rather than a fixed overlay that "forces the compositor to re-blend every frame" (index.css:1553–1559). Matches the repo's own no-continuous-repaint rule.

## Flags, in priority order

> Amended after code-level verification of the original scan. Two diagnoses were corrected (the sticky blur and the opacity framing), and line numbers now drift as the uncommitted trading files move — the findings survive, the citations age.

1. **Unguarded infinite animation.** The `ultrathink-rainbow` / `ultrathink-chroma-shift` set runs a 10s linear infinite hue-rotate on pills and frames with **no reduced-motion guard** (index.css:2157–2242). This violates the skill's mandatory Section 6.B rule and is the one place the UI contradicts its own (otherwise excellent) motion doctrine and the repo's GPU-spike guidance. Clearest actionable fix from this scan.
2. **`.mission-panel-glass` has no `@supports not (backdrop-filter)` fallback.** The fallback block (index.css:930) covers composer, dialog, dropdown, and alert glass — not the mission panel. On a UA without backdrop-filter the panel degrades to a flat 40% (light) / 58% (dark) translucent fill with the chat thread reading straight through it. One-line fix closing a real legibility hole.
3. **The muted-ink hierarchy has no contrast margin, and on glass it is nominal.** `--muted-foreground` measures 4.83:1 on card — a hair over AA with essentially no margin — so the opacity fractions land at 1.7–2.5:1. Eight real-data sites (interval label, observed/threshold figures, ledger figures, market unit, activity ages) and two interactive sites (links at ~2.5:1 whose underline is hover-only) fail outright. Worse, the glass fill means text never actually sits on `--card` but on a variable blend of card and thread, so even full opacity is a nominal pass. Site-level fixes top out at 4.83; this is a token-or-surface design decision, not cleanup (see next section).
4. **Dead `backdrop-blur-sm` on the sticky armed-watch block.** The block is `bg-card` — fully opaque — and a backdrop filter behind an opaque background composites to nothing. The blur is a visual no-op that still costs a compositing layer and per-frame filter work inside a scroll container. Deleting it (and the comment rationalizing it) is a free win. Originally mis-read as a repaint risk; the inversion matters.
5. **Em-dash, at correct scale.** The null-glyph "—" (~9 user-facing sites) is terminal convention; keep it. The prose use is one string duplicated at two call sites ("Standing aside — {because}", MissionLivePanel + TradingWorkspacePanel); collapsing it into `tradingPresentation.ts` fixes both and removes the duplication. The ~150 em-dashes in code comments are outside the rule's reach.

## The real decision: AA on the glass panel

Raising fraction sites to full opacity buys 4.83 at best, measured against a background the panel does not actually have. Genuine AA on this panel requires one or both of:

- **A darker base ink** — app-wide `--muted-foreground` (hundreds of sites, and a token shared with the upstream fork) or a panel-scoped override (`.mission-panel-glass { --muted-foreground: … }`), which localizes the blast radius and keeps the frost. This fixes the margin problem for full-strength inks only.
- **A more opaque effective surface** — a stronger fill or text-zone scrim, which trades away the frost identity that index.css's glass comments show was chosen deliberately. This is the only fix for the variable-background problem.

Until AA on this panel is a committed requirement, the defensible minimum is: fix the two failing interactive sites, add the `@supports` fallback, delete the dead blur, dedupe the string. Roughly eight lines.

## Verdict

This is a mature, self-documenting design system that already passes most of what the skill enforces — tokens over palette names, one theme across surfaces, mono-for-figures, guarded motion, designed empty states. The gaps after verification are narrow and specific: guard the rainbow animation, close the missing glass fallback, fix two failing links, delete a no-op blur. The muted-ink question is a design decision to schedule deliberately, not polish to spray site-by-site. Everything else the skill would flag is a cockpit convention taken out of the rule's intended context, or a lone token drift.
