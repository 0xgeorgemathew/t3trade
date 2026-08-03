# T3 Trade

T3 Trade is an autonomous perpetual-futures trading harness built on top of
[T3 Code](https://github.com/pingdotgg/t3code), the agent harness control
surface from Ping Labs.

Upstream gives you a control surface for coding agents on your machine. T3 Trade
keeps all of that and adds a second thing an agent can be pointed at: a live
Hyperliquid account, reached through a typed, gated tool surface rather than
through shell access.

> [!CAUTION]
> This trades real money on a real exchange. It is alpha software running
> against **Hyperliquid testnet only**. Do not point it at mainnet. Read
> [Safety model](#safety-model) before running anything.

## What it does

A _mission_ binds one agent thread to one market with a written strategy, a
maximum-loss budget, and an expiry. From there the harness runs on its own:

- **Wake on market events, not on a timer.** The agent registers watches — a
  price level, a candle close — and is resumed only when one fires, with a
  snapshot of the account, the position, resting orders, and the budget.
- **Every order passes a deterministic checklist first.** A 17-item preview
  (§16.3) runs before anything is signed: mandate, leverage, gross notional,
  exchange minimums, the reservation ledger, and a mandatory stop-loss. The
  agent cannot talk its way past it.
- **No position stays unprotected.** Every acknowledged increase must have a
  confirmed exchange-native reduce-only stop resting against it, reconciled
  against the _canonical_ position size rather than the size that was
  submitted.
- **Seven controls that never need the agent.** Pause, resume, cancel entries,
  reduce 25/50/75/100%, close, revoke, and close-and-revoke all execute
  deterministically with the provider process stopped.
- **Idempotent submission.** A deterministic cloid plus a local idempotency key
  means a retried request returns the existing record instead of placing a
  second order.

Positions, orders, and fills are always read back from the exchange. The
database records what T3 Trade _did_; the exchange remains the authority on
what is _true_.

## Layout

| Path                                     | What lives there                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `packages/trading-contracts`             | Schemas and pure rules — preview checklist, protection, risk equations |
| `packages/hyperliquid`                   | The exchange client: signing, info reads, WebSocket                    |
| `apps/server/src/trading`                | Mission state machine, execution, reconciliation, controls             |
| `apps/web/src/components/trading`        | The mission workspace and risk chrome                                  |
| `docs/architecture/trading-execution.md` | Design notes for the execution path                                    |
| `docs/upstream/`                         | The fork's contract with upstream — baseline, patch ledger, runbook    |

Everything outside those paths is upstream T3 Code and is kept close to it so
syncs stay cheap. See [`docs/upstream/PATCH_LEDGER.md`](./docs/upstream/PATCH_LEDGER.md)
for every intentional divergence.

## Safety model

- **Testnet only.** There is no mainnet configuration and none should be added
  casually.
- **The signer key is the gate.** Live execution is armed by the presence of an
  interim signer key — either `T3_TRADES_INTERIM_SIGNER_KEY` or the file at
  `<stateDir>/secrets/hyperliquid-interim-signer-key.bin`. With no key, the
  gate stays unarmed and the server runs read-only. **A server started with the
  key present will place real testnet orders; there is no second flag.**
- **Never commit or print a key.** The key never appears in logs, reports, or
  the database.
- **`T3_TRADES_LIVE_EXECUTION=1` gates the live smoke tests only** — it is read
  by `packages/hyperliquid`'s test suite and never by the server.
- **Leave the account flat.** After any live run, close the position and cancel
  resting orders.

## Running it

Install the global `vp` command (this repo uses Vite+):

```bash
curl -fsSL https://vite.plus | bash
```

Then install and run:

```bash
vp i
```

```bash
pnpm dev
```

You also need at least one coding-agent provider installed and authenticated —
Claude Code, Codex, Cursor, Grok Build, or OpenCode. See the
[provider guides](./docs/providers/codex.md).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Trading execution and reconciliation](./docs/architecture/trading-execution.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Upstream baseline and sync runbook](./docs/upstream/SYNC_RUNBOOK.md)
- [Reference](./docs/reference/encyclopedia.md)

## Upstream

T3 Trade tracks `pingdotgg/t3code` at the commit pinned in
[`docs/upstream/BASELINE.md`](./docs/upstream/BASELINE.md). The `upstream`
remote is fetch-only. Upstream's own README, install instructions, and support
channels are the place to go for anything that is not trading — this fork does
not publish releases or accept contributions.
