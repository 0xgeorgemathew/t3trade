# Plan 31 — Cockpit redesign: sidebar objects, working bottom bar, wake-up beacon

Execution doc for a build agent. Design-preserve: the existing glass/mono token
system IS the design system. No new fonts, no new icon family (lucide-react is
already the project's), no new dependencies unless a popover primitive is
missing (check `apps/web/src/components/ui/` first; fall back to `<details>`).

**Non-negotiable layout constraints**

- Chart card (left), readout card (right, `lg:w-[400px]`), status bar (below,
  full width) keep their exact dimensions and positions. Nothing resizes or
  reflows. `CHART_HEIGHT_CLASS`, `READOUT_WIDTH_CLASS`, `CARD_ROW_CLASS`,
  `PANEL_SHELL_CLASS` in `MissionLivePanel.tsx` are untouched.
- One accent for attention stays amber `--armed`; fired stays `--info`;
  long/short palette (`--profit`/`--loss`) is never borrowed for lifecycle.
- All figures stay `font-mono tabular-nums` at the existing three sizes
  (24px headline / 12px figures / 10.5px labels).
- Every removal below must keep its information reachable somewhere the spec
  names. Nothing is silently dropped.

Files: `apps/web/src/components/trading/MissionLivePanel.tsx`,
`tradingPresentation.ts` (+ `.test.ts`),
`apps/web/src/components/chat/MessagesTimeline.tsx`,
`apps/web/src/index.css` (only if a new keyframe is needed).

---

## 1. Sidebar (readout card in `MissionLivePanel.tsx`)

### 1.1 REMOVE: the thesis paragraph

Delete the `plan.because` paragraph block (`data-testid="mission-live-because"`,
the `-webkit-box` clamped `<p>`) entirely, in all states. The sentence survives
in two places: the plan popup (§2.2, its "Why" field) and the full-sentence
`title` hover on the status-bar headline (§2.1). Do not leave a spacer where it
was; the grid moves up.

### 1.2 REMOVE: the plan disclosure at the card foot

Delete `<PlanDisclosure>` from the readout card. The component itself is reused
inside the bottom-bar popup (§2.2) — move it, don't rewrite it.

### 1.3 KEEP with icon upgrades: header row

- `StateChip` gains a leading 12px icon inside the pill, before the market:
  `Radar` while `planning` ("Analysing"), `Crosshair` while "Waiting",
  `CircleSlash` while "Standing aside". `aria-hidden`, the text label stays —
  icons lead, words stay for accuracy.
- Staleness word: prefix with a 12px `Clock` icon, same amber ink.
- P&L block, ROI, collapse chevron: unchanged.

### 1.4 KEEP: progress rule, side chip row, revision note, watch stream

The watch stream (dots, sticky armed block, waterline, disclosures) is the
recently shipped lifecycle surface — no changes. The `Open` pill row and fees
figure above the grid: unchanged.

### 1.5 CHANGE: stat grid labels become icon + label

Each cell's 10.5px uppercase label gains a leading 11px lucide icon in
`text-muted-foreground/70`, `aria-hidden` (the text label is the accessible
name). Mapping — Size `Box`, Entry `ArrowRightToLine`, Mark `Crosshair`,
Stop `OctagonMinus`, Liq `TriangleAlert`, Margin `Wallet`, Risk `TrendingDown`,
Target `Target`, Protected `ShieldAlert`. The exception tones (loss-red on
Stop:None / Protected / Risk) are unchanged.

Discipline, so nine tiny icons read as one system rather than clutter: every
icon on the panel (here, the header chips, the bar, the beacon) uses
`strokeWidth={2}`, sits on the same `/70` ink as its label (exception cells
tint icon and label together), and is vertically centered on the label's
cap height. If any cell's icon+label+value cannot fit one line at 400px,
the icon is dropped from that cell rather than truncating the value.

Remove the `Next` cell from the grid in `armed` and `planning`: the countdown's
single home is now the bottom bar (§2.3). `PositionSkeleton` labels get the
same icons at `/40` ink.

### 1.6 NEW: position history pills

A new band between the stat grid (or skeleton) and the watch stream, present
whenever the mission has at least one completed round trip.

**Derivation** — add to `tradingPresentation.ts` (+ unit tests):

```
deriveRoundTrips(fills: ReadonlyArray<TradingFillView>): ReadonlyArray<RoundTrip>
// Pair open→close fills chronologically per readFillLifecycle(fill.direction).
// RoundTrip: { direction: "long"|"short", size, entryPrice, exitPrice,
//   netUsd /* closedPnl of close legs minus feeUsd of BOTH legs */,
//   closedAtMillis, orderRef }
// A close with no visible open (scrolled off the projection's LIMIT) is still
// a RoundTrip with entryPrice: null. The currently open position is NOT a
// round trip — it lives in the grid.
```

**Rendering** — one pill per round trip, newest first, max 4 shown then a
muted `+N earlier` count (same posture as the watch stream's cap). Pill:
`rounded-full border border-border/60 bg-foreground/[0.03] px-2.5 py-0.5
font-mono text-[11px] tabular-nums` on a wrapping flex row under a
`BAND_LEGEND_CLASS` heading reading `history`. Content, left to right:

- Direction glyph: `ArrowUpRight` tinted `text-profit` for long,
  `ArrowDownRight` tinted `text-loss` for short (direction of the _trade_, the
  one legitimate use of that palette here), `aria-label="long"/"short"`.
- `0.2631` size, `1,899.8 → 1,900.16` entry→exit (entry omitted when null),
  in muted ink.
- Net: `+$0.10` tinted by sign (this is P&L, so the palette is correct).
- Age: `6m ago` at `/60` ink.
  Full detail (fees split, order ids, times) on `title` hover. No expander —
  the chat's fill receipts remain the itemised record; these pills are the
  glanceable summary the brief asks for.

### 1.7 Resulting sidebar order (top → bottom)

Header row → progress rule (live) → side chip row (live) → stat grid /
skeleton → **history pills** → watch stream → revision note. The card is now
figures and objects only — zero prose paragraphs.

---

## 2. Bottom bar (`MissionStatusBar` in `MissionLivePanel.tsx`)

Same bar, same single-row height and glass material. New left→right order:

### 2.1 State object (keep, one addition)

Dot + headline sentence unchanged. Add `title={plan.because}` on the headline
span when a plan exists, so the removed thesis is one hover away even before
opening the plan popup.

### 2.2 NEW: plan popup trigger

A pill button directly after the headline:
`FileText` icon (12px) + `Plan v{mission.strategy.strategyVersion}` (or
`Plan` if no version), styled like the interval chip
(`rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px]`),
hover brightens to `text-foreground`. Hidden while `planning` (no plan yet).

Opens a popover **anchored above the bar** (`side="top"`): a
`mission-panel-glass` card, `w-[400px]` (the readout card's own width, so the
two plan surfaces share a measure), `max-h-[60vh] overflow-y-auto`, containing
exactly the moved `PlanDisclosure` body (Why / Intent / Entry trigger / Order
type / Initial size / Stop / Target / Max loss / Invalidation / Reassess
after; stand-aside keeps its lead-sentence-first form), always expanded (no
nested `<details>` inside the popup). Use the repo's existing popover
primitive if `components/ui/popover.tsx` exists; otherwise a positioned
`<details>` with outside-click close. Esc closes and returns focus to the
trigger; `aria-haspopup="dialog"`.

### 2.3 NEW: reassessment countdown (moved from the grid)

`Clock` icon + `next {formatReassessmentCountdown(...)}` (`next 13m 2s`,
`next due`), mono 11px. Absent when nothing is armed. This is now the
countdown's only home; keep the chart's future-gutter rule as the spatial
twin (gutter says where, bar says how long — the established two-homes rule).

### 2.4 NEW: prediction object

When `strategy.projection` exists (never invented for a stand-aside — the
doctrine says it states none): `TrendingUp`/`TrendingDown` icon by direction +
`→ 1,912.0 by 6:18 PM` + `v{strategyVersion}` at `/60` ink, mono 11px, with
`title` explaining "The plan's own price prediction; the dotted line on the
chart is this object." It is the bar's twin of the chart's projection line.

### 2.5 KEEP: trailing ambient cluster

`Held …`, `Funding …`, `execute · {mode}`, Hyperliquid link — unchanged, still
`ml-auto`. The `lastActivity` truncating segment stays between the prediction
object and the ambient cluster, and gives up its width first (it already has
`min-w-0 flex-1 truncate`).

**Overflow behavior, explicit.** At `lg` and above the bar is one line: drop
order is lastActivity truncates → Funding hides → Held hides → `execute ·
{mode}` hides. The plan trigger, countdown and prediction object never hide;
they are the bar's reason to exist. Below `lg` the bar keeps its existing
`flex-wrap` and is allowed a second row; the plan trigger stays in the first
row (order it directly after the headline in the DOM).

---

## 3. Wake-up message (chat stream, `MessagesTimeline.tssx` → `TradingWakeupTimelineRow`)

Replace the right-aligned muted bubble with a **centered beacon** — the
harness's heartbeat made visible as a spine down the middle of the thread.
This is the one new signature object; everything else stays quiet.

- Wrapper: `flex justify-center` (was `items-end`). Card: `max-w-[420px]`
  collapsed, `max-w-[640px] w-full` expanded.
- **Two tones, and amber is earned.** A mission wakes several times a minute;
  if every wake is amber, amber stops meaning anything. Extend `WakeupCard`
  with the raw un-humanized `cause: string` (in `deriveWakeupCard`) and split:
  - _Event wakes_ (a watch fired, a fill landed, a user command): `rounded-xl
border border-armed/30 bg-armed/[0.06]` with the icon tile in
    `bg-armed/15 text-armed`.
  - _Scheduled wakes_ (reassessment, staleness, heartbeat, bootstrap):
    neutral — `border-border/60 bg-muted/30`, icon tile `bg-foreground/[0.06]
text-muted-foreground`.
    Inner layout `px-3 py-2` for both.
- Leading icon in a `size-6 rounded-md` tile, keyed to the cause (default when
  unknown): price/candle watch fired `Zap` · pnl watch fired `Activity` ·
  schedule / reassessment / staleness `AlarmClock` · fill / order event
  `Receipt` · bootstrap `mission_created` `Play` · anything else `RadioTower`.
- Text line, one row, at most one `·` separator: `Wakeup {causeLabel}` in
  `font-medium text-foreground/85` (cause in `/70`), then `{marketLabel}` in
  mono muted separated by the single `·`, then the pending count as a tiny
  `+2` badge (`rounded-full bg-armed/15 px-1.5 font-mono text-[10px]
text-armed`) only when > 0 — a badge, not another separator segment.
- Expander: whole card is the button (as now), chevron at the far right;
  expanded payload is the same `<pre>` raw block, unchanged — the payload is
  still the authoritative record.
- Motion: on first mount of a _newly arrived_ wakeup only, reuse the existing
  `watch-tick-in` keyframe (already reduced-motion-guarded in `index.css`);
  no pulse, no loop. Historical wakeups render static.
- Keep `data-scroll-anchor-ignore` and `aria-expanded` exactly as they are.

---

## 4. What is deliberately NOT changing

- Chart card: content, levels, projection line, markers, drag — untouched.
- Watch stream rows, dots, pulse, waterline — untouched.
- `MissionStripBar` (risk chrome / way out): not duplicated into the bottom
  bar; destructive controls keep their one home.
- Collapsed row, complete-state one-liner: untouched.
- No new `·` separators beyond the ones already in the bar; no decorative
  dots (every dot on the surface carries state).

## 5. Acceptance checklist (build agent runs before handing back)

1. `pnpm typecheck`, `pnpm lint`, targeted vitest:
   `tradingPresentation.test.ts` (new `deriveRoundTrips` cases: pairing,
   close-without-open, fees-in-net, open-position-excluded, newest-first cap),
   `missionLivePanelState.test.ts` still green.
2. Screenshot light + dark at `lg` and stacked (`< lg`) against the fixture
   mission: sidebar shows no prose paragraph; history pills render; bottom bar
   one line; plan popup opens upward, scrolls, closes on Esc.
3. A stand-aside fixture shows: no prediction object in the bar, popup leads
   with "Standing aside — …", no invented levels.
4. Wakeup rows centered, cause icons correct, event wakes amber vs scheduled
   wakes neutral, payload expander intact, `prefers-reduced-motion` renders
   them static.
5. Grep: no `—` em-dash introduced in NEW UI strings (the existing
   `Standing aside — …` copy in `PlanDisclosure` predates this plan and is
   preserved, not multiplied); icon imports all from `lucide-react` at
   `strokeWidth={2}`; every number appears at most twice and the two homes say
   different things (gutter/where vs bar/how-long for the reassessment; chart
   line vs bar object for the prediction).
