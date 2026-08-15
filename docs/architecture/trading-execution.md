# Trading execution and reconciliation (PROMPT-04)

Phase 4 design note. Turns the resumed harness's typed entry requests into
validated, signed, idempotent Hyperliquid orders with reconciled fills,
positions, and cumulative-loss accounting.

This is the **only code path that spends testnet capital**. Every step below
follows the exact order in the handoff prompt; no reordering.

## Handoff to PROMPT-05

Phase 4 ships the validated signing path, the deterministic cloid, reconciled
fill/position/order reads, the cumulative-loss budget, and the reservation
ledger that protection and position management will resize. PROMPT-05 adds
exchange-native stop/TP placement, the `protected` execution status,
protection reconciliation, and deterministic user controls on top of these.

### Service surfaces PROMPT-05 builds on

- **`HyperliquidExecutionService`** — `submitOrder(input)` runs the full §17.2
  sequence (preview → persist → sign → submit → inspect → reconcile).
  `submitCancel({ market, cloid })` signs and submits a cancel-by-cloid through
  the nonce lane (used by the exhaustion guard; reuse for protection cancels).
- **`HyperliquidReconciler.reconcile(input, trigger)`** — the single convergence
  entry point. Reads canonical position/orders/fills in parallel, persists
  snapshots, releases reservations on terminal execution records. PROMPT-05's
  protection reconciliation extends the trigger set and adds a `protected_size`
  confirmation step.
- **`TradingExecutionGuard`** — `guardAction` (exhaustion gate),
  `blockForExhaustion` (block + cancel increasing orders), `reduceOnlyClose`,
  `guardResume`. PROMPT-05's `trading_control_*` tools add deterministic
  pause/resume/revoke on top of these primitives.
- **`TradingPreviewService.previewOrder`** — the 17-item checklist + Eq-4
  reservation. PROMPT-05 adds protection-placement validation.
- **`TradingBudgetReader.read`** — assembles the §16.2 budget snapshot. Takes
  `takerFeeRateBps` (loaded once by the reactor) so the open-position exit-fee
  estimate is live.

### Reservation-ledger semantics (the release lifecycle)

A reservation (`trading_risk_reservations`) is created in `submitOrder` step 2,
**before** signing, with `status='reserved'` and the preview's `reservedRiskUsd`
(the full Eq-4 value: planned loss + entry fee + exit fee + slippage reserve).
It is released (`status='released'`) by the reconciler when the tied execution
record reaches a terminal status (`filled`, `rejected`, `cancelled`, `failed`).
A unique index on `execution_id` guarantees one reservation per execution.
PROMPT-05 resizes reservations when protection modifies the planned loss.

### Caveats PROMPT-05 inherits

- **`openPositionRiskUsd` is approximate.** The exit-fee uses `weightedEntryPrice`
  as the close-notional proxy until the mark is read directly; the slippage
  reserve is zero on open positions (the protection layer writes the exact
  per-position reserve). The dominant blocking term is correct; the open
  reserve tightens in PROMPT-05.
- **`netFundingUsd = 0`.** Funding is not tracked per-fill in the POC schema.
  Until a funding source is wired, the realised mission result omits funding.
- **`trading_orders.reduce_only` is hardcoded `false`** by the reconciler
  (`HyperliquidReconciler.ts:173`). The exhaustion cancel identifies
  position-increasing orders by joining to the execution record's
  `action_type`, NOT the order row's `reduce_only`. PROMPT-05 fixes the column.
- **`protectedSize = 0`** until the protection path (§17.2 steps 6–8) confirms
  an exchange-native reduce-only stop is in place. The reconciler records zero
  until that path marks it.
- **Preview item 8 (`execution_wallet_approved`)** is an armed-signer null check
  until PROMPT-06's approved-wallet registry. The signer-to-wallet match is
  enforced at sign time, not preview.

### Nonce-lane design

`HyperliquidNonceCoordinator` serializes all signed actions (orders AND cancels)
through a single permit, so a cancel never races an order for a nonce. It
fast-forwards past spent nonces on startup (queried from the exchange),
persists a recovery hint, and restarts cleanly. The lane is the only path to
the exchange — there is no bypass.

### Cloid collision reasoning

The deterministic cloid is `trunc(SHA-256(missionId ‖ strategyVersion ‖
executionSequence ‖ actionType), 16 bytes)`, hex-encoded to 32 chars. A retry
reuses the same inputs, so the same cloid — and the exchange deduplicates on
cloid. Collisions across missions are astronomically unlikely (16 bytes of
SHA-256); within a mission the `(executionSequence, actionType)` tuple is
unique per execution. The local write deduplicates on `idempotency_key`
(derived from the same inputs), so retry idempotency holds on both sides.

### Migrations this phase added

- **038** — the six §18 tables (execution records, orders, fills, position
  snapshots, risk reservations, event inbox).
- **039** — additive columns (`trading_fills.closed_pnl`,
  `trading_position_snapshots.liquidation_price`, the reservations unique index).
- **040** — `trading_execution_records.stop_price` /
  `planned_loss_at_stop_usd` (threaded from the intent's stop; was previously
  dropped at persist time) and `trading_position_snapshots.mark_px`.

## Baseline (Phases 0–3)

- `packages/hyperliquid/` — read-only transport (InfoClient, WebSocketClient,
  MarketResolver, Precision, Gateway). **No signing code.**
- `packages/trading-contracts/` — domain contracts (mission, authority,
  strategy, watches, market/account reads). Authority already carries
  `maximumCumulativeLossUsd`, `maximumPlannedRiskPerPositionUsd`,
  `fallbackTakerFeeBpsPerSide`, `stopSlippageReserveBps`,
  `positivePnlExpandsLossBudget: false`. No execution/order/fill/reservation
  contracts — authored here.
- `apps/server/src/trading/` — mission lifecycle + §11.1 state machine +
  reactor closed loop (requested → domain write → status-set → projection).
  Migration 035 defers the six execution tables; 036 adds the mission
  projection only.
- Orchestration decider is exhaustive over 4 trading commands — adding
  commands is compile-enforced (`default: never`).
- Web: `MissionThreadPanel` renders from a pull-based mission snapshot.

## Decisions (owner did not select; proceeding with best judgment)

1. **Signer gate.** Build the full signing path and verify the EIP-712
   action hash + signature byte-for-byte against the reference SDK's
   algorithm **offline**. Land all code. **Do not submit a live testnet
   order** until the owner supplies an approved API-wallet key in a
   follow-up. The capital-spending gate stays on the owner.
2. **UI delivery.** Extend `TradingMissionSnapshot` + the mission projection
   with execution/position arrays. The bound-thread card already subscribes
   to this snapshot, so the three new cards slot in with no new RPC or atom.
   Single source of truth; matches "UI stays dumb."
3. **Implementer constants** (all overridable via `TradingRiskPolicy` /
   config):
   - Marketable-IOC allowed slippage: **50 bps** (0.5%).
   - Bounded reconciliation window: **30 s**.
   - cloid: `SHA-256(missionId ‖ strategyVersion ‖ executionSequence ‖ actionType)`
     truncated to the first 16 bytes.

## Signing algorithm (verified against nktkas/hyperliquid `src/signing/_l1.ts`)

Hyperliquid L1 actions use a **phantom-agent** EIP-712 signature over a
hash of the msgpacked action — not standard typed-data signing of the action
struct itself.

```
actionHash = keccak256(
    msgpack(action)        // insertion-order keys, undefined dropped,
                           //   out-of-int32 ints widened to bigint
  ‖ uint64BE(nonce)        // 8 bytes, big-endian
  ‖ (vault ? [0x01] ‖ addrBytes20 : [0x00])
  ‖ (expiresAfter !== undefined ? [0x00] ‖ uint64BE(expiresAfter) : [])
)

signature = EIP-712 sign({
  domain:   { name: "Exchange", version: "1", chainId: 1337,
              verifyingContract: 0x000…000 },
  types:    { Agent: [ { source: string }, { connectionId: bytes32 } ] },
  primaryType: "Agent",
  message:  { source: isTestnet ? "b" : "a", connectionId: actionHash },
})
```

**Critical invariants** (from the reference SDK):

- `chainId` is **1337**, never Arbitrum's 42161/421614.
- Msgpack **preserves insertion key order** — the action hash depends on it.
  Actions are built in the SDK's schema-declared field order.
- `undefined` fields are dropped before msgpack.
- Integers outside the int32 range are widened to bigint (else msgpack
  encodes them as float64 and the hash diverges).
- `expiresAfter` absent → marker `[0x00]` with **no** trailing bytes.
  Vault present → marker `[0x01]` + 20 raw address bytes (no `0x`).
- **Wire field names are hash-critical and not always intuitive.** The order
  leg's client-order-id key is `c`, not `cloid` (the cancel-by-cloid action's
  top-level leg uses `cloid`; the order leg uses `c`). Every L1 action carries
  a discriminating top-level `type` (`order`, `cancelByCloid`). A wrong field
  name or missing `type` produces a signature that is self-consistent with
  the malformed action but that the exchange rejects ("wallet does not exist"
  — it recovers a wrong address against the canonical hash). The order-path
  `type:"order"`, the order-leg `c` cloid key, and the cancel `type:
"cancelByCloid"` + numeric `asset` index were all live-verified in the
  PROMPT-04 remediation Gate E re-run (2026-08-02).

**No runtime SDK.** Hand-rolled with `@noble/hashes` (sha3 `keccak_256`,
utils) and `@noble/curves` (`secp256k1`), both already in the workspace
catalog. A minimal msgpack encoder covers only the subset Hyperliquid needs
(objects in insertion order, arrays, strings, int/float, bigint). This
matches the existing DPoP precedent in `packages/shared/src/dpop.ts` and
avoids pulling viem/ethers/msgpack deps.

## §16 risk (verbatim summary)

**Six equations (§16.2):**

```
realizedMissionResultUsd = closedPnlUsd + netFundingUsd - allPaidTradingFeesUsd
realizedLossUsedUsd      = max(0, -realizedMissionResultUsd)
openPositionRiskUsd      = max(0, estimatedLossFromWeightedEntryToStopUsd)
                           + estimatedUnpaidExitFeeUsd + stopSlippageReserveUsd
pendingEntryRiskUsd      = plannedLossAtStopUsd + estimatedEntryFeeUsd
                           + estimatedExitFeeUsd + stopSlippageReserveUsd
lossBudgetUsedUsd        = realizedLossUsedUsd
                           + sum(openPositionRiskUsd) + sum(pendingEntryRiskUsd)
remainingCumulativeLossUsd = max(0, maximumCumulativeLossUsd - lossBudgetUsedUsd)
```

**Missing-stop semantics (Eq 3):** `stopPrice` and `weightedEntryPrice`
are both optional on the contract. When either is `undefined`, the
directional loss-to-stop term contributes **0** — the loss is unknown, not
zero-priced. A missing stop must NOT be substituted with $0 (which for a
long computes `entry − 0 = entry`, booking the full notional as risk and
exhausting the budget instantly). The fee and slippage terms are
independent of the stop and always count. PROMPT-05's protection layer
makes the stop always present; until then a missing stop is reported
honestly as "no directional risk reserved."

**Paid vs unpaid fees never double-count** (§16.2): paid entry fees live in
`realizedMissionResultUsd`; they must not also be reserved as unpaid
open-position fees. A queued-but-unfilled entry reserves both estimated
entry and exit fees; a filled position reserves only unpaid fees.

**Profits reduce realized loss, never the ceiling** (§16.2, §16.1):
`positivePnlExpandsLossBudget` is `false`. Profits may reduce
`realizedLossUsedUsd` toward zero but never raise
`maximumCumulativeLossUsd`.

**17-item increase checklist (§16.3), in order:** mission active; entries
allowed; strategy version current; authority version current; harness run
owns lease; direction permitted; market is ETH; execution wallet approved;
account and BBO fresh; size and price valid; exchange minimum met; leverage
within user and exchange limits; gross notional within authority; planned
loss within per-position ceiling; existing reservations + proposed risk
within cumulative-loss budget; no conflicting execution pending; valid stop
defined. **Reserve before signing; reconcile after every state change.**

_Implementation note (plan-29 §3.3):_ the entry preview in
`TradingPreviewService` runs 14 of these 17 rows. The three it dropped —
strategy version current, authority version current, and the market row on
the entry side — were permission and discipline ceremony rather than
questions about whether the order itself is correct, the same reasoning the
exit checklist already applies. Exits still enforce the market row: an exit
must land in the mission's mandated market.

**Exhaustion (§16.4):** when `remainingCumulativeLossUsd ≤ 0` — cancel all
position-increasing orders; block entries, scale-ins, reversals, re-entry;
preserve valid reduce-only protection; permit only protection improvement,
cancellation of increasing orders, reduction, close, revocation; set mission
`blocked` with reason `cumulative_loss_limit`; notify. No immediate market
close while valid protection exists; no auto-resume (user must explicitly
resume or modify authority, then T3 revalidates).

## §18.2 reconciliation triggers (the eight)

1. At server startup.
2. After WebSocket reconnect.
3. Before execution.
4. After submission.
5. After each fill.
6. After position updates.
7. Before resuming a paused mission.
8. Periodically while a position is open.

**Local state never outranks Hyperliquid.** A grouped TP/SL response, a
cancellation reason, or a locally cached fill is a hint until canonical
account, order, and position state confirms it. The protection invariant
and loss-budget accounting both depend on reconciled truth.

## §17.2 ten-step entry path

Preview → persist-before-signing → submit grouped action → inspect every
per-order status → query canonical state → reconcile protection → confirm
protection → mark protected → escalate on timeout (bounded window) → never
shortcut. A 200 response, a present group, or a locally recorded child never
substitutes for canonical confirmation.

## Step map (handoff prompt steps → outputs)

| Step | Output                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| 0    | Execution/order/position/reservation/loss contracts in `trading-contracts`; interim signer loaded from `ServerSecretStore` |
| 1    | `HyperliquidNonceCoordinator` — serialized lane, monotonic nonces, fast-forward, persisted recovery hint                   |
| 2    | Deterministic 16-byte cloid                                                                                                |
| 3    | `trading_preview_order` — 17-item checklist, precision, BBO freshness, stop requirement, reserve-before-sign               |
| 4    | `HyperliquidOrderMapper` — IOC/GTC/cancel, BBO-slippage pricing                                                            |
| 5    | Submit sequence: persist record → sign in nonce lane → submit → inspect per-order status → query canonical → reconcile     |
| 6    | `HyperliquidReconciler` — fills, position, open orders; eight triggers                                                     |
| 7    | Loss accounting — six equations as pure functions + property tests                                                         |
| 8    | Exhaustion enforcement — block exposure, preserve protection, reject `trading_resume_mission` while blocked                |
| 9    | Reduce-only close orchestration                                                                                            |
| 10   | Thread surfaces: order-intent card, fill receipt, live position card                                                       |
