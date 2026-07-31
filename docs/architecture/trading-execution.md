# Trading execution and reconciliation (PROMPT-04)

Phase 4 design note. Turns the resumed harness's typed entry requests into
validated, signed, idempotent Hyperliquid orders with reconciled fills,
positions, and cumulative-loss accounting.

This is the **only code path that spends testnet capital**. Every step below
follows the exact order in the handoff prompt; no reordering.

## Handoff to PROMPT-05

Phase 4 hands PROMPT-05 the validated signing path, the deterministic cloid,
reconciled fill and position reads, and the reservation ledger that
protection and position management will resize.

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
