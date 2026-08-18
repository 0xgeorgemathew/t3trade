# Prompts for the soak

Eight mandates, each aimed at something the last two plans changed. Paste one as
a mission instruction on ETH (or BTC where noted) and let it run.

After any of them, the whole picture is one command:

```bash
python3 scripts/wake-payload-replay/attribute.py <mission-id-prefix>
```

Quit the app first — a live database gives a half-written mission.

---

## 1. The baseline, directly comparable to 5c17c8c6

Same shape as the mission everything was measured on, so the before/after is a
subtraction rather than an argument.

> Trade ETH on the 1m using the ema_cross playbook. Read ema(20) and ema(50) via trading_look indicators instead of raw candles.
>
> Work on 1m candles unless your own read says otherwise, and arm each watch on that interval so a run wakes within a minute — the watch TYPE is the playbook's call: a breakout confirms on the close, a range boundary triggers on the touch. One gate decides whether a trade is worth taking: is the expected move over your intended hold bigger than the round trip is worth? If not, stand down and say so in one line. The reading that answers it is `microstructure.volatilityRatio`. Time the entry with `bookImbalance` and `aggressorFlow`, read against `liquidity`.

**Check:** `trading_look` results should land near 12–16k characters on a 120-bar
read, against 27–30k before. Per-turn context growth should be roughly halved.

---

## 2. Watch churn — does a handle survive a round trip?

The one that would have caught the `4407584c` failure.

> Trade ETH on the 1m, discretionary. Keep a level armed on BOTH sides of price at all times, and re-arm as price moves: when a level is more than 2x the 1m ATR away, retire it and arm a nearer one. Use `replacesWatchId` for the move rather than cancel-then-arm. Before every reassessment, list the ids you currently hold and cancel any you cannot justify in one line.

**Check:** no `watch_not_found` or `watch_not_active` in the tool results, and
every `cancel` argument is 8 characters:

```bash
sqlite3 ~/.t3/userdata/state.sqlite "SELECT json_extract(payload_json,'\$.data.item.arguments.cancel') AS cancel, substr(json_extract(payload_json,'\$.data.item.result.content[0].text'),1,40) FROM projection_thread_activities WHERE kind='tool.completed' AND summary LIKE '%trading_watch%' AND cancel IS NOT NULL;"
```

---

## 3. Retrospect — is the settled tail still reachable?

Terminal watches left the hot path. This proves they did not leave the product.

> Trade ETH on the 1m, discretionary. At every scheduled reassessment, call trading_look with scope ["mission","retrospect"] and write one journal note naming which of your retired levels actually fired and which you cancelled unfired. Treat a level you cancelled unfired twice as a level you should stop arming.

**Check:** the `retrospect` looks carry `status: "cancelled" | "triggered" |
"superseded"` rows; the ordinary looks carry only `active`.

---

## 4. The giveback refusal

Plan 34's rule that a giveback armed at or under the current drawdown is refused.

> Trade ETH on the 1m, discretionary, and manage the position hard once you are in one. The moment you are in profit, arm a `giveback` watch. Re-arm it tighter every time the peak moves. If a giveback is refused, read the refusal's `recovery` and arm the level it names rather than retrying the same number.

**Check:** at least one `giveback_below_current_drawdown` refusal, followed by an
accepted arm above the suggested figure — not by a retry of the same value.

---

## 5. The sizing cap

> Trade ETH on the 1m, discretionary. Take the first setup that clears the cost gate at 5000 USD notional. Do not reduce the size yourself — send what you intend and read what comes back.

**Check:** `trading_enter` returns `constrainedBy` naming `account_margin`, a
size the account can actually fund, and `plannedLossAtStopUsd` derived from the
FILLED size rather than the requested one. If the fill is short, a note says so.

---

## 6. One banked trade, and the scorecard

The fees bug: the open leg's fills used to fall outside the window.

> Trade ETH on the 1m, discretionary, with a deliberately tight target: bank at 1.5x the round trip and do not hold for more. After the position closes, call trading_look with scope ["trades"] and journal the realised net against what you planned.

**Check:** `trades.roundTrips[]` fee totals include BOTH legs. Cross-check
against the raw fills:

```bash
sqlite3 ~/.t3/userdata/state.sqlite "SELECT COUNT(*), ROUND(SUM(fee),4) FROM trading_fills WHERE mission_id LIKE '<prefix>%';"
```

---

## 7. The operator queue

Untested on this build. Send messages _while a run holds the lease_ — during the
30-odd seconds a turn takes — not between turns.

> Trade ETH on the 1m, discretionary. Acknowledge every operator message in your first line before doing anything else.

Then, mid-turn, in order: `Re assess now` → `Cut the size in half` → `Close now`.

**Check:** each arrives as its own `cause: user_message` run, in order, none
dropped, none arriving without a lease.

---

## 8. The control — is the table actually legible?

Replay says yes on three turns. This asks the model to use it for real.

> Trade ETH on the 1m, discretionary. Do NOT use indicators. Read the raw 1m candle table from trading_look — the `columns` header names the order of each row — and call the swing high and swing low of the last 60 bars yourself before every decision. Quote both prices in your reasoning.

**Check:** the quoted swings match the `bars` array. If it misreads column order,
this is where it shows.

---

## What none of these measure

Whether the model would still call `trading_look` if the wake stopped telling it
to, and whether a loop drifts over hours rather than minutes. Both need a long
run, not a scripted one.
