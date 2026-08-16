# T3 trade tools — rethinking it around "Trade BTC"

Research note. No plan, no tasks. Plain language.

The product: a user says **"Trade BTC."** The model looks at the market, decides
what to do, tells the user what it's about to do, and does it. The user doesn't
have to answer. It repeats, taking small profits, to help someone run a
day-trading session better than they would alone.

A second, opt-in mode: a user says **"Execute strategy X"** and gets the
mechanical version — a defined rule set, executed faithfully.

Fee and mechanics research is from Hyperliquid's docs, August 2026. Sources at
the end.

---

## Part 1 — The short version

**What's wrong today:** the system makes the model write a report and pass five
stacked checks before it's allowed to trade, and it's arranged so that failing
any one of them means doing nothing. The log shows eleven reports in eight
minutes and zero trades.

**The five problems:**

1. **Every turn must file a 20-field document.** The runtime ignores almost all
   of it — but filing it cancels the price alerts set last turn.
2. **The model must classify the market before it's allowed to look for a
   trade.** There's a stand-down code (`regime_unclear`) for when it can't pick
   a label. It refuses to trade because it couldn't choose a word.
3. **Five gates in series, all must pass.** Regime resolves → setup exists →
   setup clears a cost multiple → profit target validates to 5% → stop clears a
   noise floor.
4. **Costs were measured at the wrong size**, making ordinary moves look
   unprofitable.
5. **Every order is a market order at the most expensive fee tier.** This is the
   big one and it's now quantified in Part 3.

**What changes:** the plan stays but stops being a strategy document and becomes
a statement about the position; the regime gate goes; one question instead of
five; and the fee bill drops 30–65% through order type — worth more than any
strategy improvement available.

**The product, in one line:** not a trading bot, and not a strategy engine. **A
trader that works under constraints**, uses strategies and indicators as
helpers, keeps a plan and revises it, and sets its own reasons to look again — so
a user can say "trade BTC", walk away, and still step in whenever they want.

---

## Part 2 — Strategies: opt-in, not the default path

You've drawn the right line. There are two modes and they should look different.

### Mode A — "Trade BTC" (the default, most users)

No strategy is named, so none is imposed. The model reads the market and
decides. Indicators are **readings it may consult**, never gates it must pass.
It can enter on a clean textbook setup, on a marginal one, or on a read that no
named pattern covers. The only hard limits are the risk envelope: max size, max
loss per trade, max loss for the session.

### Mode B — "Execute strategy X" (opt-in, sophisticated users)

A named strategy is a **decision procedure**, and the model's job changes
completely: from _decide_ to _execute faithfully and report_. The rules gate the
trade, deviations are reported, and the run is reproducible. This is where the
existing playbooks belong — `momentum`, `range_reversion`, `opening_range`,
`ema_cross`, `rsi_reversion` become the strategy library for this mode.

**So nothing built is wasted; it's repositioned.** The playbook machinery stops
being the mandatory path for every user and becomes the opt-in path for users
who asked for it. That's a much better fit for what it is.

### Why the current arrangement hurts Mode A

The `classify` playbook opens with:

> _"READ THE REGIME BEFORE YOU LOOK FOR A TRADE. The first thing every turn
> produces is a classification, not an entry."_

Fixed order: label the market → the label picks a playbook → that playbook has
gates → those gates decide if you may enter. Four vetoes before anyone asks
whether money can be made.

And "trending or ranging" is a lossy answer to the wrong question. The useful
question isn't _what kind of market is this_ — it's _how far is price likely to
move in the next N minutes, and is that more than it costs to get in and out?_

The system **already measures the answer**: `observedVolatility.horizons[]`
gives p25/p50/p75 of the move over each holding period, up and down separately.
That's a distribution — strictly more information than a one-word label. The
label is derived _from_ it, a veto is attached to the label, and the
distribution is demoted to "evidence, never permission."

**Regime is a hidden variable. Let the model infer it silently.** A modern model
reading the excursion distribution, recent candles and structure numbers will
form a view without filing the word "trending" — and it will handle the
in-between cases, which is exactly where the current system stalls.

### Near-misses are deleted before the model sees them

`readEmaCross` returns `null` if a cross fails on age, separation, or close
agreement. A `null` never reaches the candidate list. So _"a cross 5% under
threshold"_ and _"no cross at all"_ are indistinguishable downstream.

That's why the log alternates between the model computing "spread $1.16 vs $1.52
required" in prose and the tournament reporting "no scored candidate" — same
signal, two systems, one of which threw it away. **Never delete a marginal
signal. Report it with its margin.**

---

## Part 3 — Maker vs taker: the real numbers

This is the section that matters most, and the research changed my
recommendation from the last draft.

### Hyperliquid's actual fee schedule

Perps, base tier (under $5M of 14-day volume — where every normal user sits):

|                                       | Rate   | Basis points |
| ------------------------------------- | ------ | ------------ |
| **Taker** (crossing the spread)       | 0.045% | **4.5 bps**  |
| **Maker** (resting, adding liquidity) | 0.015% | **1.5 bps**  |

**Taker costs exactly 3× maker.** That ratio holds across every tier.

Discounts stack multiplicatively: referral is 4% off (first $25M of volume), and
HYPE staking runs 5% (Wood, 10+ HYPE) to 40% (Diamond, 500k+ HYPE). A realistic
retail setup — base tier, referral, small stake — lands around **4.1 bps taker /
1.37 bps maker.** Close enough to base that I'll use 4.5/1.5 throughout.

**Maker rebates are not available to you.** The negative-fee tiers (−0.001% to
−0.003%) require being 0.5%+ of _total exchange maker volume_. Ignore them.

### The order types that matter

- **ALO (Post Only)** — rests or is rejected. Never crosses. This is the
  guaranteed-maker primitive and it's the important one.
- **IOC** — fills now or cancels. Guaranteed taker.
- **GTC** — rests until filled or cancelled; crosses if priced through.
- **Reduce Only** — can only shrink a position. Combine with ALO for a maker
  exit.
- **Chase** — an ALO that auto-reprices to follow the best bid/ask. **Caveat:
  the docs say it runs in the browser tab that created it, max 5 active.** It's
  a UI convenience, not an API primitive — a server-side version means placing
  and re-placing ALO orders yourself.
- **TP/SL** are market orders by default, but a limit price can be set — so a
  take-profit can be a maker order while a stop stays a market order.

### The catch nobody mentions: adverse selection

Here's why "just use maker orders to save fees" is wrong as a blanket rule.

If you rest a bid and the market is falling, you get filled — someone sells into
you right before it drops further. If the market is rising, your bid never fills
and you miss the trade entirely. **Resting orders systematically fill on the
trades you least want and miss the ones you want.** That's the real price of
being a maker, and it can easily exceed the 3 bps you saved.

So the question isn't "maker or taker" — it's **which side of which trade can
afford to wait.**

### When maker actually wins

**Exits: almost always.** You hold a position, you're in profit, you have a
target. Resting a reduce-only ALO at that target is strictly better than a
market order — you were going to exit there anyway, and if it doesn't fill
you're still holding a winner. Adverse selection barely applies because your
target was fixed in advance. **This is close to free money and it's the single
easiest change.**

**Reversion entries: yes.** If the thesis is "price is stretched, it'll bounce",
you _want_ to be filled on the extension. Adverse selection works in your
favour — the fill you get is the fill you wanted.

**Momentum entries: no.** You want in now because the move is happening. A
resting bid below the market either misses the move or fills on the pullback
that invalidates you. Pay the 4.5 bps.

**Stops: never maker.** A stop is a market order by definition. Paying 4.5 bps
to get out is the cheapest part of being wrong.

### The resulting cost table

| Trade              | Entry     | Exit      | Round trip  |
| ------------------ | --------- | --------- | ----------- |
| Momentum, wins     | taker 4.5 | maker 1.5 | **6.0 bps** |
| Momentum, stopped  | taker 4.5 | taker 4.5 | **9.0 bps** |
| Reversion, wins    | maker 1.5 | maker 1.5 | **3.0 bps** |
| Reversion, stopped | maker 1.5 | taker 4.5 | **6.0 bps** |

Against today's uniform 9.0 bps, that's a **33% saving on momentum winners and
67% on reversion winners** — on identical market reads, changing nothing but
order type.

**None of this is wired up.** `resting_limit` exists in the execution contract,
but the entry path hardcodes `marketable_ioc`
([TradingQuoteService.ts:243](../../apps/server/src/trading/TradingQuoteService.ts:243)),
the quote service only prices crossing limits, and `TradingCostEstimator` has no
maker rate at all — it reads only `takerFeeBpsPerSide`. Hyperliquid's `userFees`
endpoint returns both (`userCrossRate` and `userAddRate`) in the response the
code already fetches.

### What this does to expectancy

Momentum profile — 55% win rate, +40 bps when right, −20 bps when wrong:

```
win   +40 − 6.0  = +34.0 bps
loss  −20 − 9.0  = −29.0 bps
EV = 0.55(34.0) + 0.45(−29.0) = +5.65 bps per trade
```

On $1,000 that's **$0.57 per trade**; twenty trades a day is about **$11, or 1%
of capital.** Genuinely good.

The same profile at today's flat 9 bps: **+3.15 bps**, about $6.30/day. Order
type is nearly half the profit.

And a tighter profile — 55% win, +30/−20 — goes from **−0.35 bps (losing)** at
9 bps to **+0.15 bps (breakeven)** at the blended rate. That's the margin you're
operating on.

### The honest conclusion

**You need roughly 25–40 bps of gross edge per winning trade to clear costs.** On
BTC that's 0.25–0.40% of price. During active hours that's a real, reachable
move on a 1–5 minute chart. During quiet hours it isn't there at all.

Which gives the single most useful gate in the whole system, replacing the
regime classification:

> **Is the expected move over my intended holding period bigger than ~30 bps?**
> If yes, look for a trade. If no, wait.

One number, scale-free, computed from data the system already has. No taxonomy,
no `regime_unclear`, no five-gate chain. And it correctly produces bursts of
activity when the market is moving and silence when it isn't — which is what a
good day trader actually does.

**"Many small trades" is right, but conditional on volatility.** Aim for _as
many trades as have real edge after costs_, not as many trades as possible. A
system optimising for frequency will overtrade into negative expectancy and feel
busy while losing.

### Funding: nearly always irrelevant, occasionally decisive

Hyperliquid pays funding **every hour**, at one eighth of the computed 8-hour
rate. The fixed interest component is 0.01% per 8h = **0.125 bps/hour**.

For a 10-minute hold, expected funding is about **0.02 bps** — a rounding error
against 3–9 bps of fees. So the rule is:

> **Ignore funding below ~2 bps/hour. Above that, count it.**

At 2 bps/hour, a one-hour hold costs about as much as an entire round trip. And
funding is capped at **4%/hour** — 400 bps — so in stressed markets it can dwarf
everything else. A single "funding is currently expensive/cheap/normal" flag in
the observation is enough; the current model's `fundingRatePer8h` field is the
right rate quoted over the wrong interval.

---

## Part 4 — More sensible indicators

You asked for better indicators. My strong view: **the gap isn't more chart
indicators, it's microstructure.**

EMA, RSI, MACD, Bollinger, stochastics are all monotone transformations of a
price series the model can already see as candles. They cost tokens and add
little the model can't infer. What the model genuinely _cannot_ see from candles
is **order flow** — and order flow is what actually predicts the next few
minutes, which is exactly your holding period.

**Worth adding, roughly in order of value:**

1. **Order book imbalance** — bid depth vs ask depth over the top N levels.
   The best-documented short-horizon predictor there is, and its horizon
   (seconds to minutes) matches your holding period exactly. Highest value.
2. **Aggressor flow** — of recent trades, how much volume crossed into the ask
   vs the bid. Says who is _paying_ to get in. Available from the trades feed.
3. **Book depth and spread stability** — is the book thinning? A thinning book
   means slippage is about to rise and stops are about to get run. Feeds the
   cost model directly and warns before the market gets expensive.
4. **Open interest change vs price** — OI rising with price is new longs; OI
   falling while price rises is a short squeeze. Cheap and genuinely
   informative about crowding.
5. **VWAP and distance from it** — the anchor most intraday traders actually
   use, which makes reversion to it partly self-fulfilling.
6. **Short-window vs long-window realized volatility** — one number saying
   whether volatility is expanding or contracting _right now_. This is what
   gates whether to trade at all (Part 3).
7. **Recent high-volume price nodes** — where trades actually happened, which
   is where stops cluster and where price tends to react.

**Not worth adding:** MACD, Bollinger Bands, Ichimoku, stochastics, and further
moving-average variants. Same information, more tokens.

Keep the existing EMA/RSI/pivot/range/impulse readings — they're built and
they're fine. Just present them as **numbers with context** ("9/21 EMA crossed
up 3 bars ago, spread 0.4× ATR") rather than as candidates that either exist or
don't.

---

## Part 5 — The model as position manager

**Correction from the last draft:** I said waking might be too slow. You've
verified it works, so drop that objection — it was my main argument and it's
withdrawn. The model can manage positions turn by turn.

Two reasons to still pre-commit _some_ decisions remain, and neither is about
whether waking works:

1. **Protection against things that aren't the model.** If the server dies, the
   network drops, or a turn errors, something has to close the position. One
   stop resting on the exchange at all times. Not a decision-maker — a seatbelt.
   The model chooses where it sits and moves it whenever it likes.
2. **Cost.** Every wake is a full inference. If the model pre-registers the
   mechanical exits, it only wakes for decisions that actually need judgment.

So the split is:

- **Pre-committed (mechanical):** the stop, the take-profit at the stated
  target. These are decisions the model already made; registering them as
  resting orders means they execute in milliseconds and the model doesn't need
  to be awake. And the take-profit gets to be a maker order, which is where a
  third of the fee saving comes from.
- **Woken (judgment):** "this is stalling", "the book just thinned", "structure
  broke", "we've been in 20 minutes and gone nowhere". These are exactly the
  calls a model is better at than a rule, and they're worth an inference.

**The model is the position manager.** It just isn't polling — it's setting
resting orders that carry its decisions and waking on the events it chose to
care about.

---

## Part 6 — The flow you described

> _"Based on my analysis we go short in about 5m, or when price hits X."_ → user
> does nothing → model acts.

**The plan is what makes this work, and it stays.** Asked to trade BTC the model
won't decline — it lands on something: open now, or wait for X. That commitment
is the plan, it has to be durable because it must survive until the trigger
fires, and it's what the user reads and amends.

What changes is what the plan is _about_. Today it describes a strategy. It
should describe **the position we intend to have and the conditions around it**:

```
plan {
  market        BTC
  intent        short $1,000 at 1x     ← the position we mean to hold
  entry         at 104,200  |  now  |  at 14:35
  stop          104,900                ← always present
  target        103,400
  invalidation  "wrong if it closes back above 104,500"
  reassess      by 14:50, or if the book flips
  because       one line, plain language, shown to the user
}
```

**One object, two states.** Flat, `entry` is a trigger. Holding, `entry` is
history and everything else still applies. It isn't replaced at fill — it becomes
the plan for the position. That continuity is what makes "reassess the plan" a
real operation instead of "publish a new document".

It does four jobs at once:

1. **It's the message to the user** — `because` plus the numbers is the chat
   line, generated from the same object that fires.
2. **It arms the triggers** — no separate "register a watch" step, so what was
   said and what was armed cannot disagree. Today they're two systems and they
   routinely do.
3. **It's the intervention surface** — "no", "make it smaller", "wait for
   104,500" amends one object that both the model and the user can read.
4. **It goes stale on its own.** A thesis about the next five minutes shouldn't
   still be armed forty minutes later.

**Revised, not versioned.** This is the crucial difference from today. The
current plan is versioned: publishing mints version N+1, supersedes N's watches,
and execution is gated on the version matching (`stale_strategy_version`). That
version counter is the destructive part — not the plan itself. A revised plan
updates its triggers in place. History is kept for the user and the journal, but
**nothing gates on it.**

### What is no longer in the plan

Strategy name, mode, regime verdict, `belief.evidence[]`, `timeframes[]`,
`scaleInConditions[]`, `abandonmentConditions[]`, `reentryConditions[]`,
`alternativesConsidered[]`, the eleven-field `targetProfitBasis`,
`currentAction`, `standDownCode`.

Where do the strategies and indicators go? **Into `because`, as prose, and into
the journal.** "Short — the 9/21 crossed down and the book is offered." The
strategy is a _reason_, not a structure. That is exactly what "strategies are
reference points, not doctrine" means when you write it down as a schema.

### Acting without approval

The trust model: **the user authorised the session, not each trade.** Inside the
envelope the model acts and narrates; outside it, it asks. That puts all the
weight on the envelope, so it should be explicit and visible — max size, max
leverage, max loss per trade, max loss per session, and a stop button. Given a
clear envelope, "act and tell me" is reasonable. Given a vague one, it isn't.

---

## Part 7 — The tools

Today: 24 tools, ~15,000 characters of description — about 3,700 tokens of
rulebook before any market data, most of it explaining what will be rejected.
Descriptions are long _because_ the tools refuse so much. Remove the refusals and
they collapse.

**Six tools.** The design rule behind them: **the model expresses intent and
urgency; it never computes.**

| Tool                                        | What it does                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `look(market?)`                             | One call, the whole read: price, book, candles across timeframes, expected-move distribution, indicator readings with context, order flow and book imbalance, position, account. Plus **one line of cost context** — see below. Replaces eight read tools. |
| `plan(...)`                                 | Write or revise the plan (Part 6). Arms its triggers **and makes the exchange match it** — a stop moved in the plan is a stop moved on the exchange. Announces itself to the user. **Gates nothing.**                                                      |
| `enter(market, side, size?, stop, urgency)` | Go. `urgency` is `now` or `patient`; the server turns that into IOC or ALO. **Works with or without a plan.**                                                                                                                                              |
| `exit(market, fraction?, urgency)`          | Get out, all or part, now or patiently.                                                                                                                                                                                                                    |
| `watch(condition)`                          | An ad-hoc wake, when the model wants to look again without changing the plan.                                                                                                                                                                              |
| `journal(note?)`                            | Write and read what happened. The model's memory.                                                                                                                                                                                                          |

Mode B ("Execute strategy X") adds `strategy(name)`, which in that mode _is_ the
decision procedure.

### Why `protect` disappeared

An earlier draft had a separate `protect` tool. It's redundant: the plan already
carries the stop and the target, so **writing the plan is how you move them.**
That gives a clean declarative model — the plan is the position's _declared
state_, and the server reconciles the exchange to it, which is exactly how the
rest of the system already thinks.

### Why the model never sees an order type

This is the important one. The model says **"now"** or **"I can wait."** The
execution layer turns that into `Ioc` or `Alo`, prices it, and reports what it
paid. The model does not choose a time-in-force, does not compare fee tiers, and
does not do basis-point arithmetic before trading.

Cost discipline belongs in the execution layer, where it's mechanical and
always applied — not in the decision layer, where it becomes a tax on every
thought and, eventually, a reason not to trade.

### The one line of cost context

Not a table to reason over. One sentence, for orientation only:

```
BTC · round trip here ≈ 6 bps (~$6 on $10,000) · funding negligible · book deep past $200k
```

That's it. It is **context, never a gate.** Nothing in the system compares a
target to it, nothing refuses a trade because of it, and the model is not asked
to show that it cleared it.

**Gone:** the plan's strategy scaffolding, the version counter, the target
derivation and its 5% grading, the regime gate, `minimumViableTargetUsd` and
`clearsCostGate` as gates, per-turn playbook fetches, the quote-then-execute
two-step, the seven watch types, and restating ATR to prove you computed it.

### Users still control everything through chat

"Close it", "make it smaller", "move the stop to 104,000", "go long instead",
"use 2x" — same seven tools. What goes away is the ceremony: today a
user-directed trade still needs a published plan at the current version with a
validated target basis before the execution gate passes it. That's the clearest
case of the abstraction fighting the product.

The principle the code already gets right and should generalise: **user
instructions bypass discretionary gates but never the risk envelope.**
`trading_close_position` is documented as working where an entry wouldn't —
_"Getting out never fails for a reason belonging to getting in."_

---

## Part 8 — On size and leverage

Your default of **1x and $1,000** is right, but it does two separate things and
only one is what you want:

- **It caps loss.** At 1x a 1% adverse move costs 1% of the account. Keep this.
- **It does not improve the trade.** Cost in basis points is flat until your
  order is big enough to eat through the book. On BTC that's a long way up —
  $10,000 notional costs the same _in bps_ as $1,000. It just makes ten times
  the dollars.

So: _1x/$1,000 makes each trade small, not better._ If a user states $10,000 of
tradable capital, run $10,000 at 1x — identical safety per percentage point, ten
times the result. **Scale size with stated capital; keep leverage at 1x.**

High leverage is the thing to avoid, for two compounding reasons: a large
position starts eating the order book, so slippage appears and the required move
grows; and a fixed dollar stop-loss buys a tighter and tighter stop until it
sits inside ordinary noise and gets hit by accident. Both punish exactly the fast
trading you want.

---

## Part 9 — What to keep

Most of the 50,000 lines, and they're the hard parts: the Hyperliquid gateway,
execution service and reconciler; the cost model in `costs.ts` (it needs maker
rates and a cost _curve_, but the foundation is right); every measurement in
`momentum.ts` — kept as **readings**, retired as **gates**; the watch evaluator,
event inbox, and decision lease; `levelHistory`, which is a good idea and
underused; the replay and policy-versioning discipline; and the playbooks, now
serving Mode B.

The layer to remove is the one that makes the model file a report before it's
allowed to trade.

---

## Part 10 — Honest risks

1. **Frequent small trades is the hardest mode.** Cost is fixed per trade;
   profit scales with move size. If the order-type work doesn't land first, more
   trades makes things worse. **Do the fee work before anything else.**
2. **Maker entries will sometimes cost more than they save.** Adverse selection
   is real. Measure fill rate and post-fill drift on resting entries; if resting
   bids fill 80% of the time and the market keeps going against you, that's
   adverse selection and those entries should go back to taker. Maker _exits_
   carry almost none of this risk — start there.
3. **Removing gates produces more trades before it produces better ones.** The
   replacement is the risk envelope plus a journal that measures whether trades
   without a clean setup actually pay. `assessEntryGovernance` already computes
   exactly this; it just needs trades to measure.
4. **The model will be wrong in bursts.** Keep the consecutive-loss cooldown and
   session loss limit. Those are circuit breakers, not strategy gates.
5. **Settle it with data, not argument.** Four numbers answer everything here:
   trades per session, net bps per trade, cost as a share of gross, and maker
   fill rate. A few real sessions will decide every open question in this
   document.

---

## Part 11 — The restructure, in plain words

### The one-sentence version

**The plan stays. It stops being about a strategy and becomes about the
position.**

Right now the durable thing at the centre is a versioned strategy document, and a
position is something that happens as a side effect of one. It should be the
other way round: the plan describes the position we intend to hold, and the
strategy is just one of the reasons given for it.

An earlier draft of this note said "delete the plan". That was wrong. Asked to
trade BTC the model has to land on something — open now, or wait for X — and that
commitment has to be durable, readable and amendable. The plan is that. What
needs removing is the **strategy scaffolding around it** and the **version
counter underneath it**, not the plan.

### The two things that make execution strategy-coupled today

Both are concrete and both are measurable.

**The plan schema is literally named after a strategy.** `MomentumBelief`,
`MomentumEntryPlan`, `MomentumProtection`, `MomentumPositionManagement`,
`MomentumStrategyAction`, `MomentumStrategyDirection`, `MomentumOrderPreference` —
81 `Momentum*` occurrences across 13 type names. The mission carries
`strategyFamily: Schema.Literal("momentum")`, a single-value enum. So "how a
position is protected" is, in the type system, a momentum concept. It isn't one:
a stop is a stop.

The same applies to the file itself. `momentum.ts` is named after a strategy but
contains generic market readings — pivots, EMAs, RSI, ATR, swing structure,
excursion distributions, breakouts. None of that belongs to momentum. It's just
_what the market is doing_, and it should be named that way.

**`strategyVersion` reaches all the way down to the exchange.** 69 references
across 22 files, including `HyperliquidExecutionService`, `TradingExitService`,
`execution.ts`, `quote.ts`, `history.ts` and `watch.ts`. The order that goes to
Hyperliquid carries the strategy version that produced it, and an execution can
be refused because that version moved.

That is the precise, checkable definition of "make execution strategy-agnostic":
**the execution path should take market, side, size, price, urgency and stop —
and nothing about why.** Trade history should record the reason as an
annotation, not as a foreign key that can invalidate an order.

### What each layer becomes

**The tool layer gets thin.** Today the MCP handlers are 1,173 lines and the tool
descriptions 519. Most of that is managing the plan/watch/version state machine
and explaining what will be rejected. Once there's no plan and few rejections,
the tools become near pass-throughs. Complexity moves down into services or
disappears.

**Three stores become one.** Today there are three things that must agree and
nothing that makes them: the plan (versioned), the watches (bound to a plan
version), and the resting exchange orders (bound to nothing — publishing a plan
supersedes watches but not orders). After: one object, the intent or the open
position, which owns its own triggers and resting orders. Change it and they
change with it. There's no supersede problem because there's no version to
supersede.

**The gate layer splits in two and half of it goes.** The preview pipeline
currently mixes two different kinds of check. Risk gates ask _does this fit the
envelope_ — size, leverage, loss per trade, loss per session. Those protect the
user and they stay. Discipline gates ask _did the model show its work_ — is the
plan version current, does the target basis validate, did you restate ATR
correctly. Those protect the system from the model, and they're what's costing
every trade. They go.

**The cost model changes shape, from a number to a small table.** Today it
answers "what does this size cost as a market order." It needs to answer "what
does it cost across a few sizes and both order types." That's a small change to
the estimator — the maker rate is already in the API response the code
fetches — but it turns sizing and order-type choice from something the model
derives in prose into something it reads.

**Execution grows a dimension it doesn't have.** Everything currently funnels to
a crossing IOC. Adding "patient" means resting an ALO, which means a state the
system doesn't handle today: an entry order that's placed but not filled. Someone
has to decide when to re-price it, when to give up and cross, and when to
abandon the trade. That's the one genuinely new piece of machinery in this whole
restructure, and it's worth naming: an **order working loop**. It's small, but
it's new, and it's the only part that isn't deletion or reshaping.

**The wakeup and the read tools merge.** There are two implementations of "what
does the model need to know": `TradingWakeupComposer` builds a payload, and eight
read tools build overlapping versions of the same thing. They should be one
thing. `look()` returns what a wakeup contains, and the composer becomes its
implementation. This is pure simplification with no behavioural risk.

**Memory becomes explicit.** The plan document is accidentally serving as the
model's memory across turns — which is a large part of why it's hard to delete.
Removing it leaves a real hole, and the journal is what fills it. Small new
store, rides on the observation.

**Mode becomes a concept.** Discretionary versus mechanical is a property of the
session that selects a system prompt and a tool subset. Not much machinery, but
it has to exist somewhere rather than being implied.

### What's separable and what's entangled

This matters more than any ordering, because it says where the risk is.

**Genuinely independent — touches nothing else:**

- The fee and order-type work. It lives in the cost estimator and the execution
  path and doesn't care whether the plan exists. It's also where the money is.
- Adding order-flow and book-imbalance readings. Pure addition to the
  observation.
- Collapsing the read tools into one. Mechanical.

**Entangled — one change pulls several others:**

Deleting the plan document is the hard one, and not for the reason you'd expect.
It touches the reactor, the strategy service, the watch binding and the wakeup
composer — all expected. **But it also touches the UI, much harder than it
looks.** `strategyVersion` appears 29 times across the trading components;
`plainSummary`, `targetProfitUsd`, `targetProfitBasis`, `currentAction` and the
belief fields are all rendered.

There's a silver lining in that. `tradingPresentation.ts` already flattens the
twenty-field document into about ten display fields — `thesis`, `entryTriggers`,
`stopSummary`, `targetUsd`, `maxLossUsd`, `invalidation`, `initialSizeUsd`,
`isStandDown`, `alternatives`. **The presentation layer has already worked out
which subset is actually useful**, and it's very close to the seven-field intent
object. So the UI isn't just an obstacle — it's a ready-made specification for
what should replace the document.

### What gets smaller, what disappears, what stays untouched

**Disappears:** the plan's strategy scaffolding (belief, mode, regime,
alternatives, the eleven-field target basis, the nine-value action enum, the
three extra condition arrays), the version counter and the
`stale_strategy_version` gate, the regime gate, the quote-then-execute two-step,
the seven watch types, per-turn playbook fetches, and the `Momentum*` prefix on
everything that isn't about momentum.

**Survives, reshaped:** the plan itself — smaller, position-centric, revised
rather than versioned.

**Gets smaller:** the tool layer, the preview pipeline, the strategy service, the
wakeup composer (merged into the observation).

**Gets bigger:** the cost model (by a little), execution (by the order working
loop), the observation (by order flow).

**Untouched:** the Hyperliquid gateway, the execution service's signing and
submission path, the reconciler, the fill reconciliation, the decision lease,
`momentum.ts`'s measurements, the replay and policy-versioning discipline. That's
the majority of the code and all of the parts that are hard to get right.

### The line that decides everything else

**A bot executes rules. A trader exercises judgment inside limits.**

That distinction is the whole architecture. It means the constraint layer has to
be hard, small, and completely separate from the decision layer:

- **Constraints (hard, few, visible):** which market, how much size, what
  leverage, most you can lose on a trade, most you can lose in a session, and a
  stop button. This is the entire safety story and a user should be able to read
  it in one glance before walking away.
- **Judgment (unconstrained):** direction, timing, entry, exit, sizing within the
  cap, when to bail, which indicators to consult, whether to trade at all.

Today these are tangled — discipline gates are implemented alongside risk gates
in the same preview pipeline, so loosening the model's freedom looks like
loosening safety. Once they're separated you can give the model a genuinely free
hand _and_ tell the user exactly what they've risked. That separation is what
makes "load your money and let it trade" a defensible product rather than a scary
one.

### The honest summary

This is not a rewrite. It's stripping the strategy scaffolding off the plan,
pulling `strategyVersion` back out of the execution path, reshaping the cost
model, one small new component, and a UI migration that's more work than it
sounds. The engine is fine. What's being removed is the compliance form bolted to
the steering wheel — and the only genuinely new thing is the bit that lets an
order wait patiently instead of always paying to cross.

---

## Part 12 — Deep dive: what the code actually does

Seven findings from reading the reactor, the coordinator, the preview pipeline,
the order mapper and the migrations. Three of them change the picture.

### F1 — Publishing is what drives the state machine

`analysing → waiting` happens **because a plan was published**
(`TradingStrategyService`, folded into the same transaction as the insert). The
mission's status machine has an edge that only the publish act can take.

So the plan isn't decoration on the side of the loop — it's the gear the loop
turns on. That's why removing it feels bigger than it should: the status machine
has to learn a new reason to move. In a position-centric model the natural
edge is _"a plan now exists and its triggers are armed"_ — which is the same
event, minus the version.

### F2 — A run cannot start without a published plan

From the reactor: _"the `mission_created` cause is the only one allowed to
proceed without a published strategy (coordinator check 7)."_

**This is the ignition of the churn loop.** The model must publish before it can
ever be woken again. Combine with the fact that publishing supersedes the prior
version's watches, and you get the eleven-versions-in-eight-minutes behaviour
mechanically: publish to stay wakeable → supersede your own alerts → re-arm →
get woken → publish again.

It's not the model being verbose. **The loop requires a publish to keep
breathing, and each breath cancels the last one's alarms.**

### F3 — Versioning is in the schema, not just the code

`trading_watches.strategy_version INTEGER NOT NULL`, with an index
(`idx_trading_watches_mission_strategy_version`) built specifically to support
supersession. `trading_missions` carries `strategy_version`, `strategy_family`
and a separate row `version`. And the strategy table is literally named
`momentum_strategy_versions`.

So "revise, don't version" is a migration, not a refactor. Not a hard one — drop
a column, drop an index, rename a table — but it's schema work and it touches
persisted rows.

### F4 — The one-mission rule is a database constraint

```sql
CREATE UNIQUE INDEX idx_trading_missions_one_active_per_user
ON trading_missions (user_id) WHERE status NOT IN ('revoked','completed')
```

One active mission per user, enforced in SQLite. So "trade BTC and ETH at the
same time" isn't a service change — it's a migration.

Its sibling is worth keeping, though:

```sql
CREATE UNIQUE INDEX idx_trading_harness_runs_one_active_per_mission
ON trading_harness_runs (mission_id) WHERE status NOT IN ('completed','failed')
```

**One decision at a time per mission, enforced by the database.** That's a good
invariant and it should survive untouched. It's what stops two turns racing to
open the same position.

### F5 — Post-only orders are not reachable at all

The order mapper is a two-way branch:

```ts
t: {
  limit: {
    tif: order.timeInForce === "ioc" ? "Ioc" : "Gtc";
  }
}
```

There is no `Alo`. And this matters more than "a missing enum value", because
**GTC is not a maker guarantee.** A GTC limit priced through the book crosses
and pays taker. So today's `resting_limit` gives you the maker fee _only if the
price happens not to cross_ — and silently pays 3× more if the market moves into
you first.

**Only ALO guarantees maker.** Every number in Part 3 depends on a branch that
doesn't exist yet. It's a small change — a third TIF value and a rejection path
for "would have crossed" — but it is the foundation of the entire fee argument,
and it's currently absent.

### F6 — The preview pipeline is mostly fine, and already knows the answer

I expected to find the gates concentrated here. They aren't. Of the 17 entry
checks:

| Kind                                                | Checks                                                                                                                                                                                           | Verdict         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| **Risk** — protects the user                        | `direction_permitted`, `leverage_within_limits`, `gross_notional_within_authority`, `planned_loss_within_per_position_ceiling`, `reservations_plus_proposed_within_budget`, `valid_stop_defined` | keep, unchanged |
| **Correctness** — can this order be sent            | `execution_wallet_approved`, `account_and_bbo_fresh`, `size_and_price_valid`, `exchange_minimum_met`                                                                                             | keep            |
| **Control** — user switches                         | `mission_active`, `entries_allowed`                                                                                                                                                              | keep            |
| **Concurrency**                                     | `harness_run_owns_lease`, `no_conflicting_execution_pending`                                                                                                                                     | keep            |
| **Discipline** — protects the system from the model | `strategy_version_current`, `authority_version_current`, `market_is_eth`                                                                                                                         | **remove**      |

Three of seventeen. The pipeline is in good shape.

Better still, **the codebase has already discovered the split I was going to
recommend** — and applied it once, to exits:

> _"None of those rules is wrong about entries. They are simply about entries.
> The exit list below keeps every check that is about whether this exit can be
> executed correctly, and drops every check that is about whether more exposure
> should be permitted."_

That is exactly the right reasoning. The recommendation is just: **apply it a
second time, to entries.**

### F7 — The real friction is doctrine, not code

This is the most encouraging finding in the whole review, and it reframes the
effort.

Very little actually _rejects_. Enforced rejections are: three discipline checks
in preview, two target-basis defects at publish, and nine checks in the stop
adjuster. That's it.

Everything else that's slowing the model down — read the regime before you look
for a trade, run the tournament, publish on every assessment, justify a
stand-down against the best candidate, derive the target three ways — is **prose
the model obeys because it was told to**, living in `playbook.ts` and in 15,000
characters of tool descriptions. Nothing enforces it.

**So a large fraction of the behaviour change is prompt and doctrine work, not
code deletion.** That's cheaper, faster, and reversible. It also means the
behaviour can be tested well before the schema is touched — rewrite the doctrine,
run a session, and see how much of the churn disappears without a single
migration.

---

## Part 13 — What a real session looks like

Concrete walkthrough. User has **$10,000** of tradable capital, default 1x. BTC
around $104,000. One position at a time.

**09:14 — the user types "Trade BTC" and closes the laptop.**

The mission is created with the mandate: BTC, $10,000 max notional, 1x, max
$150 loss per trade, max $400 for the session.

The model calls `look(BTC)` once and gets everything: price $104,120, spread
$2.10, top-of-book depth well past $10,000, 1m/5m/15m candles, the expected-move
distribution (5m median 22 bps, p75 41 bps), EMA and RSI readings, **book
imbalance 1.7:1 offered**, aggressor flow 62% selling, funding 0.008%/hr
(ignorable), and the cost table:

```
$10,000 notional   taker/taker 9.4 bps $9.40 · taker/maker 6.2 bps $6.20 · maker/maker 3.0 bps $3.00
```

It writes a plan and one line to the user:

> _"Sellers are leaning on it — book is offered 1.7:1 and we've failed twice at
> 104,400. I'll short $10,000 if we tag 104,300, stop 104,650, target 103,700.
> Risk $34, aiming for $58. If it doesn't trigger by 10:00 I'll look again."_

Under the hood that's one plan object, one price trigger armed at 104,300, and
one time trigger at 10:00. Nothing is on the exchange yet. The user's phone shows
the sentence. They ignore it.

**09:31 — price tags 104,300. The model wakes.**

It re-reads. Imbalance still offered, no news, the level held. It enters —
**taker**, because this is a momentum-ish entry and it wants in now. Fills at
104,296. Cost: $4.50 in fee, $0.20 in spread.

Immediately it places two resting orders: a **stop-market at 104,650** (the
seatbelt, on the exchange, not negotiable) and a **reduce-only ALO take-profit at
103,700** (maker, 1.5 bps instead of 4.5). It sets two wake conditions: _price
moves 25 bps either way_, and _20 minutes with no new low_.

The plan hasn't been replaced. `entry` is now history; stop, target and
invalidation still apply. The user's panel shows: short 0.096 BTC from 104,296,
risk $34, target $58, and that one sentence.

**09:48 — 20 minutes, no new low. The model wakes on its own stall trigger.**

Price is 104,180 — up $11 on the position, going nowhere. Book imbalance has
flattened to 1.1:1. The model judges the edge gone and doesn't want to pay
funding or risk a reversal for $11.

It cancels the take-profit and exits — **taker**, because it wants out now.
Result: **+$11 gross, −$9.40 costs, −$1.60 net.** A small loss.

It writes to the journal: _"stalled, flow flattened, cut it. Entry was fine, the
follow-through wasn't."_ The user's panel logs one line. They still haven't
looked.

**10:20 — a second setup, this one reversion.**

Price has run to 104,610 and the 5m RSI is stretched with a fresh high on
falling volume. The model wants to fade it, and because it's _fading_ it can
afford to wait: it places a **maker ALO sell at 104,640**, above the market. If
price extends into it, that's the fill it wanted.

> _"It's stretched. I'll short at 104,640 if it pushes there — resting, so we pay
> a third of the fee. Stop 104,900, target 104,200."_

**10:26 — filled at 104,640** (1.5 bps, $1.50). Stop and a maker take-profit go
on immediately.

**10:53 — the take-profit fills at 104,200.** Both sides maker.

**+42 bps gross = $42.00. Costs $3.00. Net +$39.00.**

**By 15:30 the session has taken 8 trades:** 5 winners averaging +$24 net, 3
losers averaging −$29 net. **Net +$33 on $10,000 — about a third of a percent.**

That is a decent, unspectacular day, and it's the honest shape of this: small
edges, repeatedly, with costs kept low. Three of those eight trades would have
been net losers at the old flat 9.4 bps taker rate. **Order type is the
difference between a positive day and a flat one.**

The user opens the app at 15:40, reads eight sentences and one number, and either
lets it keep going or types "stop for today."

### What the user actually experienced

One command. Eight plain-English sentences over six hours. One number that
matters. The ability to type "make it smaller" or "stop" at any moment and have
it obeyed on the next tick. **They never saw a regime classification, a cost
multiple, a strategy name, or a version number** — and none of those would have
made them better off.

---

## Part 14 — Limitations, honestly

Things this architecture does not fix, and things it can't do at all.

### It removes obstacles to trading. It does not create edge.

**This is the big one.** Everything in this document is about letting the model
act on its reads cheaply and quickly. Nothing here establishes that the reads are
any good. If the model's directional calls are coin flips, better plumbing just
loses money more efficiently — the cost work reduces the bleed rate, it doesn't
reverse the sign.

**The only thing that settles this is real sessions with the journal on.** Net
bps per trade, over a few hundred trades, is the number. Everything else is
argument.

### The cost floor rules out the fastest trading

Round trip is 3–9 bps whatever you do. Moves under ~30 bps are unreachable, which
excludes true scalping, most mean-reversion at the tick level, and anything
market-making-like. **The system lives in the 5-minute-to-1-hour band and cannot
go faster**, no matter how fast the wakes get.

### Latency has a floor even with fast wakes

Wakes work — but the model still reads, thinks and calls a tool. That's seconds.
Ruled out: news reactions, liquidation cascades, arbitrage, anything where being
200ms late means being wrong. The resting stop covers the catastrophic case;
nothing covers the merely-fast case.

### Maker entries are an unproven bet

Part 3's numbers assume resting entries fill at a useful rate without systematic
adverse selection. That is an assumption, not a finding. If resting bids fill 85%
of the time and price keeps going against you, the 3 bps saved is bought with
more than 3 bps of worse entries. **Maker exits are safe; maker entries need
measuring before they're trusted.**

### You cannot backtest this

An LLM policy can't be cheaply replayed over history the way a rule set can. The
existing replay machinery covers the deterministic parts — cost model, detectors,
thresholds — and that's genuinely valuable, but the decision itself is
unbacktestable. **You will be evaluating on forward data with real money, which
means small size for a long time.**

### Non-determinism makes attribution hard

Two identical market states can produce different decisions. So "did that change
help?" is a statistics question needing a lot of trades, not an A/B you can run
over a weekend.

### Inference cost is a real line item

Every wake is a full inference. A busy session with a position open and tight
triggers could be a few hundred. Pre-committing stop and target is what keeps
this affordable — but on a volatile day it's still a meaningful cost against a
$33 profit.

### Single venue, single account, one position

Hyperliquid only, one active mission per user (a database index), one market per
mission. No hedging, no cross-venue, no portfolio. Widening any of these is a
migration.

### Market stress breaks the assumptions

The cost model reads a visible book. In a crash the book vanishes, slippage goes
non-linear, funding can hit its 4%/hour cap, and every number the model is
reasoning from is stale. **The honest answer is that this system should stand
down in genuine stress, and it currently has no reliable way to detect it.** A
depth-and-spread-collapse trigger is the minimum, and it's not built.

### "Walk away" means genuinely unattended

If the server dies with a position open, the only thing between the user and a
large loss is the resting stop on the exchange. That's why it isn't optional and
why it goes on _at the same time as the entry_, not on the next wake.

### It's the user's money and keys

Nothing here is a hedge against the model being confidently wrong for an entire
session. The session loss limit is the backstop, and it is a blunt one. Users
should size this as money they can lose.

---

## Part 15 — "Move boldly, don't let fees be a hindrance" — is that right?

**Right about the architecture. Incomplete about the economics. And the gap
between them is smaller than it looks.**

### Where the instinct is exactly right

Cost must never be a **gate**. Today it is one, in several places:
`minimumViableTargetUsd`, `clearsCostGate`, `costs_exceed_target`, the entry
cost multiple, the graded target basis. Every one of those turns "this trade
costs something" into "you may not take this trade", and that is precisely the
machine that produced eleven refusals in eight minutes.

A tool that makes you prove profitability before acting will mostly not act.
**Delete every cost gate.** No argument.

### Where it can't be taken literally

Fees aren't a policy, they're physics. At 9 bps round trip you need ~30 bps of
move to make a trade worth taking; at 3 bps you need ~10. A model that genuinely
ignores this will take 8 bps trades all day and lose money reliably — not
because it's badly designed, but because it's paying more to trade than the
trade is worth.

So the constraint can't be _removed_. But it can be **moved off the model.**

### The resolution: make the fee small enough to ignore, and put it where the model isn't

Two moves, and together they give you what you actually want:

1. **The execution layer picks the cheap order type automatically.** The model
   says "now" or "I can wait." It never sees a time-in-force, never compares
   fee tiers, never does basis-point arithmetic. Cost discipline becomes
   mechanical and universal instead of a per-decision tax.
2. **The cost appears once, as one line of context, and gates nothing.**
   _"Round trip here ≈ 6 bps (~$6 on $10,000)."_ The model reads it the way a
   trader glances at the spread — it informs, it doesn't permit.

**The fee work is not a constraint on boldness. It is what makes boldness
affordable.** At 9 bps, "quick trades and get out" needs 30 bps moves, which
mostly aren't there — so the model is forced to wait, which is the opposite of
what you want. At 3 bps it needs 10 bps, which is available constantly. **Cutting
the cost is what unlocks the fast, frequent trading, not what restrains it.**

### On the coding-tool analogy

It's a good lens and worth taking seriously. What it gets right:

- **Say what you want, it acts, you can intervene.** Correct, and it's the whole
  interaction model.
- **A decent result now beats a perfect result never.** Exactly right, and it's
  the antidote to the current system's behaviour.
- **Tolerance for imperfection, with fast iteration.** Right.

Where it breaks, and it matters: **code is reversible and free to re-run. Trades
are neither.** A bad function costs a re-run; a bad trade costs money that
doesn't come back, and closing it costs more.

But that difference has a design answer rather than being a reason for caution:
**make each position small enough that being wrong is cheap.** That is what 1x
and modest size actually buy — not safety in the abstract, but **the right to be
wrong often**, which is the precondition for the coding-tool interaction model to
work at all.

So the 1x default has a better justification than caution: _it's what makes
iteration affordable._ Twenty small trades where four are mistakes is a fine day.
Two large trades where one is a mistake is not.

### What I'd do

Your framing, with one addition:

> Let the model trade freely inside a hard envelope, with no cost gates and no
> proof-of-work — **and make the plumbing cheap enough that "freely" is actually
> affordable.**

The cost work isn't a competing priority to boldness. It's the enabling
condition. Do it first, then remove every gate, and the model gets to be as bold
as you want it to be.

---

## Part 16 — How strategies and indicators stay useful once sidelined

The change is smaller than it sounds, and it's mostly one type signature.

### The mechanical change: from verdict to reading

**Today** an indicator is a _producer of candidates_. `readEmaCross` returns a
setup or `null`, and `null` means no candidate exists — the signal is deleted
before the model sees it. The indicator holds a veto.

**After**, an indicator is a _field in the observation_. Always present, always
numeric, never null, never pass/fail:

```
today:   readEmaCross() → CandidateSetup | null      ← null deletes the signal
after:   ema: { fast: 104,180, slow: 104,240,
                crossed: "down", barsAgo: 3,
                separationAtr: 0.4 }                 ← always there, no verdict
```

No `score`, no `clearsCostGate`, no `requiredCostMultiple`, no null. Just what is.
The model reads it the way a trader reads a chart.

That single change fixes the near-miss problem from Part 2: a cross 5% under its
old threshold and no cross at all stop being indistinguishable, because there is
no threshold any more — just a separation number the model can weigh.

### Four ways they stay genuinely useful

**1. As compression.** "9/21 crossed down 3 bars ago, separation 0.4 ATR" is a
compact summary of 120 candles. The model _could_ derive it, but handing it over
is cheaper and more reliable than making it recompute — and unlike the current
arrangement, nothing depends on it being decisive.

**2. As vocabulary for the user.** The `because` line has to be readable by a
human who trades: _"it's stretched and the book's offered"_ lands instantly with
someone who knows RSI and depth. Indicators are the shared language between the
model and the user, which is a real job even when they aren't driving the
decision.

**3. As opt-in doctrine (Mode B).** When someone says "execute the range
reversion strategy", the playbook stops being reference and becomes the
procedure. All the existing playbook text survives here, unchanged, doing the job
it was written for — just for the users who asked for it.

**4. As journal tags — and this is the best one.** Every trade records which
readings were notable at entry. After a couple of hundred trades you can ask:
_do my EMA-cross entries actually pay? Do RSI fades? Which readings precede the
losers?_

That **inverts the relationship**. Today a strategy asserts up front that it
works and is given a veto on that basis. After, the journal _measures_ whether it
works and feeds that back as evidence the model can weigh. Strategies stop being
a priori rules and become a posteriori evidence — which is the only honest way to
know whether one is any good.

`assessEntryGovernance` already computes almost exactly this split (trades with a
scored setup behind them versus trades without, and the net of each). It was
built as a governance check; it's actually the seed of the learning loop, and it
just needs trades to measure.

### What's genuinely lost

Only one thing: the model can no longer be _made_ to consider a strategy it
would otherwise ignore. Today the doctrine forces the tournament — every
strategy scored, every turn. Without it, a model that has settled into reading
momentum may simply stop noticing ranges.

The mitigation is the journal, not a rule: if the record shows the session is
taking one kind of trade and the losses are concentrated there, that's visible
and correctable. **Measured, not mandated** — which is slower to take effect but
doesn't cost a turn every time.

---

## Part 17 — The interface: one chart, and the chart is the mission

### Why the panel is cluttered

**It mirrors the data model instead of answering a question.** Every field on
`TradingPlanState` earned itself a `PlanField` — `plainSummary`, `thesis`,
`regime`, `entryTriggers`, `orderType`, `initialSize`, `stopSummary`, `target`,
`maxLoss`, `scaling`, `invalidation`, `targetRationale`, `alternatives`. Then
`MissionStrip` adds eleven more values, `PositionStrip` adds Size/Entry/Mark/Liq,
and `WakeupCard` renders raw JSON.

It wasn't designed cluttered. It was _reflected_ cluttered. Which means the plan
work in Part 6 removes most of it for free — a seven-field plan cannot produce a
thirteen-row disclosure. But shrinking it isn't the same as designing it.

### The six questions a walk-away user has

In priority order, for someone who typed "trade BTC" and closed the laptop:

1. Am I up or down? _(one number)_
2. What am I in?
3. What's protecting me, and what's the worst case in dollars?
4. **What is it about to do next?**
5. Why?
6. What's happened so far?

The current panel answers all six at equal visual weight, plus a dozen nobody
asked — regime, order type, target rationale, scaling policy, alternatives
considered, harness provider.

### The chart is the interface, and it is a conveyor

Not a widget inside a stats panel. The primary surface, carrying the whole
mission state.

**The metaphor to commit to: plans enter on the right, become events as they
cross the "now" divider, and recede leftward as record.** Past is what happened,
the divider is the present, the gutter to its right is what the model intends.

That is what makes left-to-right motion meaningful rather than decorative. A
trigger visibly _approaches_ the divider; when it fires it becomes a fill marker.
**The plan turns into history in front of the user.**

It also answers question 4 — _what is it about to do_ — spatially, with no text
panel, which is the thing a stats layout can never do well.

### Let the geometry carry the meaning

Five shapes, no legend needed, because the form says what the thing is:

| Thing                                          | Shape                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Price trigger                                  | horizontal segment in the gutter that **stops at its expiry** — bounded, not infinite, so "at what price" and "until when" read as one mark |
| Scheduled reassessment                         | vertical rule at its time                                                                                                                   |
| Time-stop                                      | vertical rule in the position's colour                                                                                                      |
| Stop and target                                | the only lines that cross the divider, because they're the only commitments that persist                                                    |
| Stall trigger ("out if no new low for 20 min") | a marker that **slides right** each time a new low prints — watching the deadline reset is honest about how the rule works                  |

### Most of this is already built

The in-flight geometry work has the foundation: `nowX`, a **future gutter**
(_"the share of the plot held empty to the right of now"_), `ChartTimeMarker` for
_"a future moment the plan is committed to, drawn as a vertical rule"_,
domain-pinning with chevrons for levels outside the visible range, and
`findLevelAtPrice` — which is hit-testing, the seed of interactivity.

So this is not a new design. It's a half-built one worth finishing deliberately.

**What's missing:**

1. **Motion.** Re-rendering per projection update makes the chart _jump_.
   Advancing `nowX` smoothly is the difference between a chart that updates and a
   chart that moves.
2. **Bounded segments.** Triggers currently read as full-width rules; they should
   end at their expiry.
3. **Drag.** See below.
4. **Sliding markers** for relative conditions.
5. **A visual register for "hypothetical."** Gutter contents should be quieter
   than the past — thinner, dashed, lower opacity. Today a future line and a past
   line would read as equally real. The future should _look_ like it hasn't
   happened.

### Interactivity, and why it matters architecturally

**Inspection:** hover a candle for OHLC, a fill for price/size/fee paid, a marker
for what it is. Pinch or scroll to change the time window.

**Direct manipulation** is the important one: drag the stop line and the stop
moves, with a live dollar-risk readout under the finger. Drag the target. Drag a
trigger's price. Drag the end of a trigger segment to extend its expiry.

That's more than a nice gesture. **Dragging the stop is a `plan()` revision.** The
UI writes the same object the model writes — _one object, two authors_. It is the
cleanest possible expression of "the user can intervene at any time": no separate
command path, no special-case API, and the model simply finds a plan it didn't
author on its next wake.

Which settles the conflict question: **the user's drag wins.** It's journaled
with `author: user`, and the model is told. It adapts, or says why it disagrees.

### Taste

One colour for risk, one for reward, one neutral for time. Not a rainbow.

Labels on hover only, with two permanent exceptions — the stop's dollar loss and
the target's dollar gain — because those are the two numbers a walk-away user
needs without interacting.

**No more than four or five future markers.** Which buys a free diagnostic: **if
the chart looks busy, the plan is too complicated.** The interface becomes a check
on the architecture.

Beyond the chart, four rules:

- **One hero number.** P&L. Everything else visibly smaller.
- **Prices become lines, never rows.** Anything denominated in price gets drawn
  at its price. This alone deletes four to six stat rows.
- **The model speaks in sentences, never fields.** No `Regime: ranging`. If it
  matters, it's in the sentence.
- **Conditional display.** Show a value only when it's actionable — spread when
  it's wide, funding when it's expensive, liquidation price when it's near. Most
  numbers are boring most of the time, and boring numbers are the clutter.

### What's left outside the chart

Three things: **the P&L number** above it, **one sentence** below it, and **the
journal timeline** in a drawer. Everything else — position stats, watch condition
rows, plan fields, the wakeup JSON — becomes a mark on the chart or goes away.

The journal timeline is worth noting: it's the same object as the model's memory
(Part 7), rendered. So the session narrative comes free, and it's what a user
actually scrolls when they come back after two hours.

**One number, one chart, one sentence, one history.**

### The layout should differ by state

- **Waiting** — chart, the dashed trigger segment, "waiting for 104,300,
  reassessing at 10:00". Very sparse.
- **In position** — chart with entry/stop/target lines, P&L hero, one sentence.
- **Between trades** — chart plus the timeline of what just happened.

### The forcing function

There's a mobile app, and "walk away, check on my phone" is the core use case.
**If it doesn't fit on a phone, it isn't the default view.** That single test
settles most arguments about what earns a place — and it's the right test,
because the walk-away user is who this is for.

---

## The whole thing in nine lines

1. Keep the plan. Make it about the position, not the strategy — and revise it
   rather than versioning it.
2. Take `strategyVersion` out of execution. An order should carry market, side,
   size, price, urgency, stop — and nothing about why.
3. Stop making the model classify the market before it can look for a trade.
4. One question — _is the expected move bigger than ~30 bps?_ — instead of five
   gates.
5. Fix order type first: maker exits always, maker entries on reversions, taker
   on momentum. Worth 33–67% of the fee bill and more than any strategy change.
6. Add order flow and book imbalance, not more chart indicators.
7. Model manages the position; it pre-commits stop and target as resting orders
   and wakes for judgment calls.
8. Strategies are opt-in helpers — "Execute strategy X" gets the mechanical path,
   "Trade BTC" gets a free hand and cites them as reasons.
9. The chart is the mission: past on the left, now in the middle, the model's
   intentions in the gutter on the right — draggable, and busy only when the plan
   is too complicated.

---

## Postscript — what got built, and the four places it differs

Added 2026-08-16, after plan 29 landed phases 0–10. This document is the
argument, not the record; the record is
[`plan-29-trader-restructure.md`](../operations/plan-29-trader-restructure.md),
and its Appendix B lists every decision taken against this text. Almost all of
the nine lines above were built as written. Four were not, and a reader coming
to this document later should not be misled by them.

**1. Seven tools, not six — and `strategy` is not mode-B-only.** Part 8's table
lists six and says `strategy(name)` is what Mode B adds. What shipped is
`trading_look`, `trading_plan`, `trading_enter`, `trading_exit`,
`trading_watch`, `trading_journal` and `trading_strategy`, all seven available
in both modes. The playbooks turned out to be worth reading in discretionary
mode too — `classify` for a regime read and `standing_rules` for what holds
always — so denying the tool would have cost the free-hand mode something it
uses. Execute mode changes what the playbook _means_, not what the model can
call.

**2. The mode is derived from the mandate, not stored on the mission.** Part 2
describes Mode A and Mode B as a setting. `mode.ts` reads them out of the
mandate text on every look, so the mode can never disagree with the words the
operator typed. It also means the reading is a regex over English, which took
two passes to make safe — see Appendix B, A17.

**3. Leverage is not 1×.** Part 9 argues for "scale size with stated capital;
keep leverage at 1×", and the reasoning holds. The shipped testnet authority
allows up to 20× and 8× capital of gross notional
([authority.ts](../../packages/trading-contracts/src/authority.ts)). The
per-trade and per-session dollar ceilings — 7% and 35% of capital — are what
actually bounds the loss, and they bound it the same way at any leverage. The
argument was not rejected; it was made redundant by expressing the limit in
dollars instead.

**4. Dragging a trigger was not built.** Part 17 asks for the stop, the target,
a trigger's price and a trigger segment's expiry to all be draggable. Stop and
target are. A trigger is not, deliberately: the trigger's DESCRIPTION carries
the authoritative price, so moving a `priceLevel` alone publishes a plan that
contradicts itself in prose; and the armed watch does not move with a revision,
so the mission would keep waking at the old level. The reasons are written into
the `PlanDragTarget` type so the next person to reach for it finds them.

---

## Sources

- [Hyperliquid — Fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) — perps tier table, staking and referral discounts, maker-rebate tiers
- [Hyperliquid — Order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types) — ALO/IOC/GTC, reduce-only, TP/SL, Chase and its browser-tab limitation
- [Hyperliquid — Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) — hourly payment, 1/8 of the 8h rate, 0.01%/8h interest component, 4%/hour cap
- [Hyperliquid — `userFees` API](https://nktkas.gitbook.io/hyperliquid/api-reference/info-methods/userfees) — `userCrossRate` and `userAddRate`, both already in the response the code fetches
