# Wake & tool-call token reduction — what the database says

Every number below is a query result against `~/.t3/userdata/state.sqlite` with
the app quit. Mission **5c17c8c6** (ETH, ema_cross mandate, 2026-08-18 10:58–11:11
IST, 8 turns, entered and closed one short). Reproduce with:

```bash
python3 scripts/wake-payload-replay/attribute.py 5c17c8c6
```

---

## 1. Turn-by-turn attribution and the growth curve

**What filled the context, whole mission (229,292 characters of model-bound content):**

| category                         |   n |   chars |     share |
| -------------------------------- | --: | ------: | --------: |
| `trading_look` results           |   9 | 195,644 | **85.3%** |
| wake payloads                    |   8 |  13,501 |      5.9% |
| `trading_plan` results           |   8 |   7,938 |      3.5% |
| `trading_watch` results          |  14 |   5,634 |      2.5% |
| `trading_strategy` results       |   1 |   3,029 |      1.3% |
| model output                     |   8 |   2,200 |      1.0% |
| `trading_enter` + `trading_exit` |   2 |   1,346 |      0.6% |

**H1 is confirmed, and it is not close.** The wakes are 5.9% of the problem.
Every one of the eight turns called `trading_look` — nine calls for eight turns.

**Per turn** (wake + tool results + model output, and the running total):

| turn |  wake | tool chars | out |   turn | cumulative |
| ---: | ----: | ---------: | --: | -----: | ---------: |
|    1 | 1,304 |     32,002 | 296 | 33,602 |     33,602 |
|    2 | 1,796 |     32,069 | 353 | 34,218 |     67,820 |
|    3 | 1,426 |     31,492 | 267 | 33,185 |    101,005 |
|    4 | 1,534 |     13,341 | 228 | 15,103 |    116,108 |
|    5 | 1,224 |     32,324 | 261 | 33,809 |    149,917 |
|    6 | 1,521 |     29,361 | 297 | 31,179 |    181,096 |
|    7 | 2,475 |     21,406 | 284 | 24,165 |    205,261 |
|    8 | 2,221 |     21,596 | 214 | 24,031 |    229,292 |

The provider's own accounting agrees: `usedTokens` went **16,383 → 120,325**
across 37 model calls. The steps are 10–13k tokens each and they land on the
turn boundaries where a `trading_look` result arrives.

Turn 4 is the tell. It is the one turn that asked for `bars: 30` instead of
`bars: 120`, and it cost less than half of every other turn.

---

## 2. Inside `trading_look`

Section by section, for the 120-bar reads:

| section                                    |                 chars |      share |
| ------------------------------------------ | --------------------: | ---------: |
| `candles`                                  |         16,293–16,307 | **55–62%** |
| `mission`                                  | 2,066 → 6,902 (grows) |      8–31% |
| `structure`                                |           3,677–4,245 |     12–14% |
| `orderBook`                                |                ~1,509 |         5% |
| `volatility` + `higherTimeframeVolatility` |                ~1,360 |         5% |
| `microstructure`                           |               452–629 |         2% |
| everything else                            |                ~1,000 |         4% |

**`candles`.** 120 bars × 131 characters. Of those 131: **69 are the eight key
names**, repeated on every bar, and **48 are `openTime` and `closeTime`** — two
13-digit stamps that a contiguous series makes derivable from the first open and
the interval. Roughly 22 characters a bar are the actual OHLCV.

**`mission`** is the part that grows, and `watches` is why: 3,588 characters on
the last read, of which **1,661 (46%) were seven terminal rows** — cancelled,
triggered, superseded. It also carried the authority block twice: `mission.authority`
and a sibling `authority`, byte for byte identical, plus `harness` and `control`
the same way — **718 characters of self-duplication per read**.

**Recurring-identical between consecutive looks.** Mostly small, with one glaring
case: looks 4→5 repeated the entire 4,906-character `mission` section verbatim,
and looks 8→9 (both inside turn 8) repeated ~6,900 characters of it.

**The wakes**, across the seven non-bootstrap wakes (12,197 characters):

| part                                                         | chars | share |
| ------------------------------------------------------------ | ----: | ----: |
| `armedWatches`                                               | 3,563 | 29.2% |
| static boilerplate (`omitted` + mandate line + review lines) | 2,938 | 24.1% |
| UUID bytes                                                   | 1,692 | 13.9% |
| `pendingEvents`                                              |   640 |  5.2% |

---

## 3. Verdicts, with turn-level citations

| section                                                    | verdict                  | the citation                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candles` (raw window)                                     | **re-encode**            | No assistant message in any of the 8 turns quotes a bar. Every number quoted traces to `indicators` (t2 "1897.29", t3 "$0.01 separation", t5 "1896.30 vs 1896.68"), `volatility.atrUsd`, `costContext`, or the wake's own `pendingEvents` (t4 "the triggered close at 1895.9"). But dropping the window outright **diverged** in replay, so the verdict is a lossless re-encoding, not a cut. |
| `mission.watches` terminal rows                            | **retrospect**           | No turn refers back to a retired watch. A watch that fires arrives as its own wake's `triggeringWatch`.                                                                                                                                                                                                                                                                                       |
| sibling `authority`/`harness`/`control`/`authorityVersion` | **redundant**            | Byte-identical to `mission.mission.*` in the same payload.                                                                                                                                                                                                                                                                                                                                    |
| `orderBook` levels 11–20                                   | **redundant**            | `microstructure.bookImbalance` reports `levels: 10`; `liquidity.nearDepthUsd` sums the same window. The mandate routes book-reading through those readings, and t6's published `because` quotes `bookImbalance`, never a level.                                                                                                                                                               |
| watch UUIDs                                                | **replace with handles** | t8 cancelled seven watches; **two failed**. `4407584c-8df5-460f-ad0e-1ae79930717a` is `4407584c`'s head with `42d86ff4`'s twelve-hex tail — `watch_not_found`, and the 1896.09 invalidation level stayed armed after the position closed.                                                                                                                                                     |
| `omitted` block + `mandate-and-authority`                  | **compress**             | 208 identical characters saying the same thing twice. Kept as one line, not removed: the model called `trading_look` on 100% of turns and this is what tells it to.                                                                                                                                                                                                                           |
| `pendingEvents` when empty                                 | **dead**                 | Rendered as `pendingEvents: -` on 4 of 7 wakes.                                                                                                                                                                                                                                                                                                                                               |
| `pendingEvents` when populated                             | **push-required**        | _Not_ redundant with `triggeringWatch`, contrary to the hypothesis: t2's event carries 1896.3 where the watch line rounds to 1896, and t4's watch line has no `observed` at all while the event has "closed 1895.9".                                                                                                                                                                          |
| `strategyReview` / `positionReview`                        | **push-required**        | t7 answered `positionReview` directly: "no stop trail is justified yet".                                                                                                                                                                                                                                                                                                                      |
| `structure.candidates` (1,736)                             | **unproven — kept**      | No turn cites it, but this mission was playbook-directed (`ema_cross` named in the mandate). Judging it needs a discretionary mission.                                                                                                                                                                                                                                                        |
| `higherTimeframeVolatility` (681)                          | **unproven — kept**      | Never cited; 2.5% is not worth an unevidenced cut.                                                                                                                                                                                                                                                                                                                                            |
| duplicate-watch dedupe at arm time (H3)                    | **not supported**        | The three watches near 1896 differ in `confirm` (touch vs close) and in purpose (plan invalidation vs prediction invalidation). An exact-duplicate rule would have caught none of them. Not implemented.                                                                                                                                                                                      |

---

## 4. Minimal payload, current vs shipped

Measured by applying exactly what shipped to the recorded payloads.

**`trading_look`** — 195,795 → 107,171 characters, **−45%**:

| look | before |  after | cut |
| ---: | -----: | -----: | --: |
|    1 | 27,292 | 14,364 | 47% |
|    2 | 29,603 | 16,293 | 45% |
|    3 | 29,587 | 15,610 | 47% |
|    4 | 13,350 |  7,872 | 41% |
|    5 | 30,199 | 15,991 | 47% |
|    6 | 26,507 | 12,065 | 54% |
|    7 | 21,410 | 12,443 | 42% |
|    8 |  9,097 |  6,440 | 29% |
|    9 |  8,750 |  6,093 | 30% |

**Wakes** — 12,197 → 10,581, **−13%**.

**Whole mission** — 229,443 → 139,203 characters, **−39%** (≈57.4k → ≈34.8k tokens).

---

## 5. CLI results

`codex exec` (gpt-5.6-luna, low) and `claude -p` (claude-sonnet-5, low). A pass
is the same `action` and `direction` on both models with levels in tolerance.

**Isolated candle arms** (turns 3, 5, 7):

| arm                                                           | result                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `L1only` — window re-encoded as a table, nothing else changed | **6/6 matched**                                                                                                |
| `nocandles` — window removed entirely                         | **5/6**; t3/codex went `stand_aside` → `plan_only short`. This is why the chart is re-encoded rather than cut. |

**Full reduced bundle** (turns 2–8, both models, 14 runs): 13/14 matched. The
one divergence was **turn 2 on codex**, and re-running each arm four times
produced `plan_only` and `stand_aside` from _both_ arms — sampling noise on a
borderline turn, not a payload effect. Nothing was restored.

**Shipped encoding** (turns 2–8, both models, 14 runs): **14/14 matched**,
turn 2 included.

---

## 6. Patches, narrow to wide

| commit      | cut                                                                   | validated by                                          |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `b1551bedd` | candle window → table                                                 | `L1only` arm, 6/6                                     |
| `03015e7fc` | book bounded to the 10 levels `microstructure` measures               | reduced bundle (removed the book entirely and passed) |
| `a2104fcfd` | settled watches → `retrospect`; duplicated siblings dropped           | reduced bundle, 13/14                                 |
| `10d357c5d` | eight-character watch handles, resolved on `cancel`/`replacesWatchId` | reduced bundle; also fixes the t8 cancel failure      |
| `8f8e709af` | one `readFirst:` line; empty `pendingEvents` omitted                  | reduced bundle                                        |
| `2eee84c44` | the replay harness itself                                             | —                                                     |

---

## What is still open

- **`trading_look` is called on every wake regardless.** The pointer line is
  load-bearing and the mandate is honoured, so per-wake pull remains push with
  extra steps. The fix taken here was inside the payload; whether the _mandate_
  should be conditional is a separate question this data does not answer.
- **`structure.candidates` and `higherTimeframeVolatility`** need a discretionary
  mission before they can be judged.
- **Prior claim corrected.** The seed hypothesis that `pendingEvents` restates
  `triggeringWatch` is wrong — it carries an observed value the watch line does
  not. And the near-duplicate watch hypothesis (H3) does not survive: the
  watches differ in confirmation type.
- **The soak.** None of this measures whether the model still calls the tool,
  or how a long loop drifts. That is the operator's run.
