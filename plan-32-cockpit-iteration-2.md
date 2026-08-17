# Plan 32 — Cockpit iteration 2: triggers, history, composer, header capsule

Execution doc for a build agent. Iterates on plan-31 (already in the working tree);
plan-31's constraints and tokens carry forward unchanged. Design read: redesign-preserve
of the dark glass trading cockpit, VARIANCE 3 / MOTION 3 / DENSITY 7. No new fonts,
no new icon family, no new dependencies — lucide-react (existing dep), `ui/tooltip.tsx`
(exists, has a `glass` variant), `ui/popover.tsx` (exists).

Signature move this iteration: **the watch stream speaks the chart's language.** The
chart gutter already labels levels `○ ▲ 1,902.3 · above`. Watch rows adopt the same
triangle-direction + mono-figure vocabulary, so a row in the sidebar and its dotted
line on the chart read as the same object in two places.

Non-negotiables (unchanged from plan-31):

- `CHART_HEIGHT_CLASS`, `READOUT_WIDTH_CLASS`, panel shell classes untouched. No resize, no reflow.
- Lifecycle colors never borrow the profit/loss palette. Amber = armed, `--info` blue = fired.
- Mono figures at the established sizes (24 / 12 / 11 / 10.5px). All icons `strokeWidth={2}`.
- Every removal's information keeps a named home. The two-homes rule for figures stands.
- No new em-dashes in copy. Numeric placeholder "—" in value cells is the grid's existing
  vocabulary and is allowed; prose em-dashes are not.
- Upstream lints ban native `title` tooltips: every hover surface added or touched in this
  plan uses `ui/tooltip.tsx`, and any `title=` on elements this plan rewrites is migrated.

---

## 1. Watch stream ("triggers panel") — logic first, then chrome

File: `apps/web/src/components/trading/MissionLivePanel.tsx` (`WatchStream`,
`WatchStreamEntry`, `WatchDot`) and
`apps/web/src/components/trading/tradingPresentation.ts` (`deriveWatchLifecycle`).

### 1.1 Why the screen fills (the logic problem, fix at the derivation)

Every replan supersedes the previous prediction's watches. One reassessment retires
3–6 watches in the same tick, so the settled half of the stream opens with a burst of
near-identical rows — `cancelled 1m 43s ago` three times in the screenshots — and a
mission that re-levels every few minutes buries the rows that matter (the fired ones)
under administrative churn. Two derivation changes in `deriveWatchLifecycle`:

**a) Group supersession bursts.** After building `settled`, fold consecutive rows that
(1) have outcome `replaced` or `cancelled` and (2) settled within a 5-second window of
each other into one group row. New row shape (extend `WatchStreamRow` with a variant or
add a parallel `WatchStreamGroup` type — build agent's choice, but the stream array must
stay one ordered list):

- `kind: "group"`, `count`, `outcomeLabel` (`"replaced"` when all members are
  supersessions, else `"retired"`), `atMillis` (newest member), `members:
ReadonlyArray<WatchStreamRow>` (newest first).
- Never group `triggered`/`consumed` or `expired` rows. A firing is an event the
  operator follows; only take-downs group.
- A burst of one renders as today's single row — no group chrome for a lone cancel.

**b) Coarse ages.** Add `formatAge(millis): string` to `tradingPresentation.ts`:
`"just now"` under 60s, `"4m ago"` under an hour, `"1h 12m ago"` past it — never
seconds once a minute has passed. The stream, the history band and the group rows all
use it. `formatDuration` stays as-is for countdowns (the bottom bar's `next 5m 3s`
legitimately counts seconds). This kills the "armed 8m 47s ago" tick-noise that makes
every row look freshly minted.

Tests (`tradingPresentation.test.ts`): a burst of three same-window supersessions folds
into one group of 3; a fired row inside the window stays out of the group; two bursts
9 seconds apart stay two groups; a lone cancel renders ungrouped; `formatAge`
boundaries at 59s/60s/1h.

### 1.2 Row anatomy — icons first

Today's row is a sentence: `ETH 1m candle closes above 1,9…` truncated, `armed 8m 47s ago`.
Three words of it are redundant on every row: the market (the card header already names
it — single home) and the verb phrase (the predicate type). New anatomy, one line,
`font-mono text-[11.5px]`, same `BAND_PAD_CLASS` grid for every row:

```
[dot] [type icon] [▲|▼] [figure] [interval] ......... [v n] [age]
 ●     ⧙candle⧘    ▲     1,902.3   1m                  v6    9m ago
```

- **Lifecycle dot** — unchanged (`WatchDot`, amber pulse / info blue / hollow / muted).
- **Type icon**, `size-[11px]`, ink `text-muted-foreground/60`, `strokeWidth={2}`:
  - `candle_close` → `ChartCandlestick` (verify the export exists in the installed
    lucide-react; fallback `BarChart3`)
  - `price_cross` → `Crosshair` (already imported; Crosshair consistently means
    "a price level" across this card)
  - `pnl_above` / `pnl_below` / `pnl_giveback` → `Activity` (the wake beacon's PnL
    icon — one vocabulary)
  - `metric_threshold` → `Gauge`
  - `order_update` / `position_update` → `Receipt` (the beacon's fill icon)
- **Direction triangle** — text glyphs `▲` / `▼`, not icons, matching the chart
  gutter's own labels. Colored `text-muted-foreground` (NOT profit/loss — direction
  of a predicate is not a side of a trade). Omitted for types with no direction
  (`order_update`, `position_update`, `pnl_giveback`).
- **Figure** — the threshold, formatted by type (`formatPrice` / `formatSignedUsd` /
  raw metric value), `tabular-nums`, `text-foreground/90` on armed rows,
  `text-muted-foreground` settled. This is the row's payload; it never truncates —
  the icon drops before the figure does (plan-31's discipline rule).
- **Interval chip** — only `candle_close` carries one: the bare literal (`1m`, `5m`)
  in `text-muted-foreground/60`. `metric_threshold` puts the humanized metric name
  here instead (`volume ratio`).
- **`v n`** — unchanged.
- **Age** — `formatAge`, `text-muted-foreground/60`.

`describeWatchCondition` stays (the disclosure, tests and a11y still want the sentence);
the row builds from structured fields instead. Extend `WatchStreamRow` with
`watchType`, `direction: "above" | "below" | null`, `intervalLabel: string | null`
so the component never re-parses the description string. `aria-label` on the row =
the full `describeWatchCondition` sentence; the icons are `aria-hidden`.

The expanded disclosure (`last read X, against Y` / `then: …`) is unchanged.

### 1.3 Group row anatomy

```
[hollow dot] [count] watches replaced ................ [age]
```

("watches", not "levels" — a group can contain PnL and metric watches, which are not
levels.) `text-muted-foreground`, no type icon (a group spans types). Rendered as a `<details>`:
expanding lists the members as ordinary settled rows (1.2 anatomy) indented under it.
The `+N earlier watches not shown` cap line and `droppedConditions` line are unchanged,
except their ages/counts also use `formatAge` where they show times.

### 1.4 Keep

Sticky armed block, waterline hairline, `MAX_SETTLED_WATCH_ROWS`, `watch-dot-pulse`
reduced-motion guard, the just-fired hold-in-place beat, scroll container heights.

---

## 2. Position history — uniform rows, hover-reveal detail

File: `MissionLivePanel.tsx` (`PositionHistory`, `HistoryPill`),
detail content mirrors `MissionThreadPanel.tsx`'s FillReceipt fields.

Design intent from the operator: the full-sized fill receipts in the chat thread will
eventually go away (not this iteration). The history entry is therefore designed as
the future single home: everything a receipt says must be reachable from the entry.

### 2.1 Uniform geometry

Replace the variable-width `flex-wrap` pills with **one entry per row**, every row the
same fixed grid — identical dimensions and structure by construction:

```css
grid-template-columns: [dir] 14px [lev] auto [size] 1fr [prices] auto [net] auto;
```

Alignment across rows is the point, and separate per-row grids size their `auto`
columns independently — rows would drift. Structure: **one parent grid** on the band
carrying the `grid-template-columns`, each entry a `col-span-full grid
grid-cols-subgrid` row (Chromium supports subgrid; this app is Electron/Chromium).

Row: `h-7`, `rounded-full border border-border/60 bg-foreground/[0.03] px-2.5`,
`font-mono text-[11px] tabular-nums`, `gap-x-2`, rows stacked with `gap-y-1.5`. The
pill look survives; the dimensions stop varying and the columns rule up vertically.

### 2.2 Unified segment format (resolves the `price1 → price2` inconsistency)

Every row renders **all five segments, always**:

1. **Direction glyph** — `ArrowUpRight` / `ArrowDownRight`, `size-3`,
   `text-profit` / `text-loss` (the one legitimate palette borrow — it IS the trade's
   side; unchanged from plan-31).
2. **Leverage tag** — `formatLeverage(mission.leverage ?? deriveEffectiveLeverage(position))`
   in the receipt's own chip style (`rounded-sm bg-current/15 px-1`). Honesty note:
   fills do not record leverage; this is the mission's configured leverage, which is
   the mandate the trade ran under. If both sources are null the segment renders "—".
3. **Size** — `formatSize`, `text-muted-foreground`.
4. **Prices** — always the pair structure: `1,899.8 → 1,900.16`. When the opening
   fill is off the projection window (`entryPrice === null`) render `— → 1,900.16`.
   One structure, no conditional shapes.
5. **Net** — `formatSignedUsd(netUsd)`, tinted profit/loss.

**Removed from the face: the running clock** (`57m 19s ago`). Time moves into the
hover detail as the absolute close time. Nothing else about `deriveRoundTrips`
changes — the derivation and its tests stand.

### 2.3 Hover-reveal detail (the receipt, relocated)

Replace the native `title` multiline string with `ui/tooltip.tsx` (`glass` variant,
`side="left"` so it doesn't cover the stream below). Each row becomes a focusable
`<button type="button">`, and the button does something: hover and keyboard focus open
the tooltip (Base UI opens on focus), and **click toggles the same content as a
`Popover`** — without the click path, a touch screen can never reach the detail, and
a button that only hosts a hover effect is a dead affordance. One shared content
component, two openers; the build agent may implement it as a Popover whose trigger
also carries the tooltip, so long as only one surface shows at a time. Detail content,
in the popover Row label/value style:

- Header: `ETH · 1x · Long` (market, leverage chip, side — the receipt's badge).
- `Opened` — size @ entry, fee, absolute time, order id. When the open leg is off
  the window: `older than the panel's fill window`.
- `Closed` — size @ exit, fee, absolute time, order id.
- `Realised` / `Fees` / `Net` — the three figures (`closedPnlUsd`, `feesUsd`, `netUsd`).

`aria-label` on the row button = the same content flattened to one sentence.

### 2.4 Keep

`MAX_HISTORY_PILLS = 4` + `+N earlier`, `history` band legend, band position
(between grid/skeleton and watch stream), newest-first order, open position excluded.

---

## 3. Composer footer — return to upstream

Files: `apps/web/src/components/ChatView.tsx`,
`apps/web/src/components/trading/MissionComposerControls.tsx` (delete).

Audit fact for the build agent: `ChatComposer.tsx`, `ProviderModelPicker`,
`ModelPickerContent`, `composerProviderState` and the traits (effort) picker are
**already byte-identical to upstream** — the model selection and effort selector need
no restoration in code. The fork's only composer-footer additions are the two mission
pills (`Hyperliquid · Testnet`, `Entries allowed`) rendered through the
`missionControls` slot.

- Remove the `missionControls={<MissionComposerControls …>}` spread in `ChatView.tsx`.
- Delete `MissionComposerControls.tsx`. Keep the `missionControls?: ReactNode` slot on
  `ChatComposerProps` (it is additive, unused, and keeps the upstream-sync diff small) —
  or remove slot + spread together if the sync policy prefers zero dead props; either
  way no trading UI renders in the footer.
- **Keep `assetPicker`** (the draft-hero market picker) — it is how a mission starts;
  it renders only before the first message and was not in the complaint.
- Information homes: the account/network fact and the entries-permission fact move to
  the header capsule's popover (§4.3) — they were already partially there
  (`Connection` row, pause note); §4.3 completes them. Nothing is lost.

---

## 4. Header mission capsule — centered, redesigned

Files: `apps/web/src/components/chat/ChatHeader.tsx` (slot placement),
`apps/web/src/components/trading/MissionHeaderPill.tsx` (rewrite in place).

### 4.1 Placement: true center

The header today renders `breadcrumb → missionSlot → actions` in one flex row; the
pill sits wherever the breadcrumb ends. Change `ChatHeader` so the mission slot is
**absolutely centered in the header bar**:

```tsx
{
  missionSlot ? (
    <div
      className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex
                  -translate-y-1/2 justify-center"
    >
      <div className="pointer-events-auto no-drag-region">{missionSlot}</div>
    </div>
  ) : null;
}
```

- The header is already the positioning context (or add `relative` to it).
- `no-drag-region` (or the codebase's equivalent) so the capsule stays clickable over
  the Electron drag region; verify against `workspace-topbar drag-region` handling.
- Collision rule: an absolutely centered element cannot know how long the breadcrumb
  is, so shrinking tiers alone cannot prevent overlap at mid widths. Guard explicitly:
  below the header container width where the full capsule plus typical breadcrumb fit
  (start at `@3xl/header`, tune against real titles), the capsule leaves the overlay
  and renders in today's inline slot after the breadcrumb, in its narrowest tier. The
  centered treatment is earned only where it fits; overlapping the title is never
  acceptable.

### 4.2 Capsule anatomy

One glass capsule, `rounded-full border border-border bg-card/60 backdrop-blur
px-3 py-1`, hover `bg-card`, focus ring as today. Anatomy left to right:

```
[tone dot] [MARKET] [state icon] [state word] | [P&L] [phase dots] [Close & stop]
```

- **Tone dot** — existing `TONE_DOT` map; `animate-pulse` only while `exposed`
  (unchanged — the one earned animation).
- **Market** — `font-medium`, the capsule's anchor word.
- **State icon** — the sidebar StateChip's exact family, one vocabulary across
  surfaces: `Radar` analysing / `Crosshair` waiting / `CircleSlash` standing aside;
  while exposed, `TrendingUp`/`TrendingDown` per side. `size-3.5`, `strokeWidth={2}`.
- **State word** — `text-muted-foreground`; while exposed it is the exposure label
  (`Long 0.2631`) instead of a state word.
- **P&L** — exposed only, `tabular-nums`, profit/loss tint (it is money).
- **Phase dots** — the existing 6px breadcrumb dots, kept, `aria-hidden`, with the
  phase list moved from `title` into the popover (native-title ban).
- **Close & stop** — unchanged §14.7 behavior: inline, destructive, only while
  exposure exists, `stopPropagation` so it never merely opens the popover.

Collapse tiers (container query on the header, mirroring today's `@lg/@2xl/@3xl`
pattern): full anatomy → drop phase dots → drop state word (icon stays, and the
popover keeps the words) → below `sm` the capsule is dot + market + state icon only.
Close & stop never drops while exposed; if the tier cannot fit it, the capsule
yields the P&L before the button.

### 4.3 Popover (existing, completed)

Keep the current popover rows and actions. Add, under `Connection`:

- `Entries` — `Allowed` / `Paused`
- `Re-entry` — `Allowed` / `Not allowed`

(the two facts evicted from the composer footer; `Pause after close` folds into the
existing paused note). Move the phase breadcrumb's labels here as a
`Phase` row (`entry · manage · exit`, current phase in foreground ink). Replace the
popover's native `title` on the error line with visible truncation + the styled tooltip.

---

## 5. Not changing in this iteration

Chart card and gutter labels; stat grid and its icons; wake beacon; bottom status bar
(plan popup, countdown, prediction object); `MissionStripBar`; fill receipts in the
chat thread (their removal is a later iteration — §2.3's tooltip is the prerequisite);
`deriveRoundTrips`; collapse/complete rows.

---

## 6. Acceptance checklist

1. `pnpm typecheck`, `pnpm lint` (native-title rule green on touched files),
   targeted vitest: `tradingPresentation.test.ts` (grouping, `formatAge`,
   extended `WatchStreamRow` fields), existing `deriveRoundTrips` suite untouched
   and green.
2. Screenshots light + dark, `lg` and stacked: watch stream with a mixed page
   (armed, fired, a supersession group, a lone cancel); history band with a
   window-truncated entry showing `— → exit`; centered capsule in all three states
   and while exposed; composer footer on a mission thread pixel-matching a
   non-trading thread's footer (model picker + effort + modes, no pills).
3. Reduced motion: dot pulse static, capsule pulse static, no new animation anywhere.
4. Keyboard and touch: history row focus opens the detail tooltip, click/tap opens the
   same content as a popover (verify on a coarse-pointer emulation); capsule popover
   and watch disclosures unchanged.
5. Electron: centered capsule clickable over the drag region; window-control insets do
   not overlap it; at a width where the breadcrumb would collide, the capsule is in the
   inline fallback slot, not overlapping the title.
   5b. History band: columns align vertically across all rows (subgrid), including a row
   with a `—` entry price and a row with a `—` leverage chip.
6. Grep gate: no new `—` in prose strings, no new `title=` attributes, every new icon
   `strokeWidth={2}`, no profit/loss classes on lifecycle elements.
7. Churn fixture: replay a mission with 3 replans in 15 minutes — settled list shows
   3 group rows + fired rows, not 12+ individual cancels; nothing reads
   "N s ago" after its first minute.
