<div align="center">

# T3 Trade

**An Agentic Trading Environment (ATE)** for running coding agents on perpetual
futures markets with a defined strategy, loss budget, and deterministic controls.

_Alpha · Hyperliquid **testnet only** · macOS + web · MIT_

**[t3trade.pages.dev](https://t3trade.pages.dev)** · [Releases](https://github.com/0xgeorgemathew/t3trade/releases)

<img src="docs/media/t3trade-mission.png" alt="T3 Trade showing a BTC mission with the agent's plan, active price watches, and position details" width="920" />

<sub>A live mission showing the agent's plan, active price watches, and position
data from the exchange.</sub>

</div>

---

T3 Trade is a fork of [T3 Code](https://github.com/pingdotgg/t3code), Ping
Labs' open-source interface for coding agents. It keeps T3 Code's repository
workflows and adds typed, restricted tools for a Hyperliquid testnet account.

The agent reads market data, creates a plan, and explains its actions. T3 Trade
enforces the mission rules. Every proposed order must pass a deterministic
checklist, every confirmed position increase requires an exchange-native stop,
and you can pause, close, or revoke a mission without the agent running.

> [!CAUTION]
> This alpha software places real orders on Hyperliquid testnet. It supports
> **testnet only** and has no mainnet configuration. Read the
> [safety model](#safety-model) before running anything.

## What it does today

A **mission** connects one agent thread to one market with a written strategy,
a maximum-loss budget, and an expiry. T3 Trade then handles the following:

- **Event-driven agent runs.** The agent can register watches for a price cross,
  an unrealised-PnL level, or a candle close. When a watch fires, the agent
  receives current account, position, order, and budget data.
- **A 17-check order preview.** Before signing, T3 Trade checks the mission,
  leverage, notional, exchange minimums, price bands, order-book freshness,
  risk reservations, and the required stop-loss. Any failed check rejects the
  order.
- **Required position protection.** Every confirmed position increase must
  have an exchange-native reduce-only stop. The stop size is reconciled against
  the position size reported by the exchange.
- **Controls that work without the agent.** Pause, resume, cancel entries,
  reduce by 25/50/75/100%, close, revoke, and close-and-revoke work even when
  the agent provider is stopped.
- **Idempotent order submission.** A deterministic client order ID and local
  idempotency key prevent a retry from placing the same order twice.
- **Tested loss accounting.** Property tests cover budget, reservation, and
  exhaustion calculations. An exhausted budget blocks new exposure without
  removing stops from open positions.

T3 Trade reads positions, orders, and fills from the exchange. Its database
stores its own actions, while exchange data remains the source of truth.

### What it does not do

T3 Trade does not choose strategies, promise returns, or support unattended
trading with real funds. It is built for supervised, budgeted testnet
experiments.

## Running it

You need Node.js (`^22.16 || ^23.11 || >=24.10`), the `vp` command, and at
least one coding-agent CLI installed and authenticated.

```bash
curl -fsSL https://vite.plus | bash
```

```bash
vp i
```

```bash
pnpm dev
```

`pnpm dev` starts the server and web app locally. A packaged macOS
(Apple Silicon) desktop build is available from
[GitHub Releases](https://github.com/0xgeorgemathew/t3trade/releases); other
platforms run from source.

Supported agent providers (install and log in to at least one):

- Claude: [Claude Code](https://claude.com/product/claude-code) — `claude auth login`
- Codex: [Codex CLI](https://developers.openai.com/codex/cli) — `codex login`
- Cursor: [Cursor CLI](https://cursor.com/cli) — `agent login`
- Grok Build: [Grok Build CLI](https://x.ai/cli) — `grok login`
- OpenCode: [OpenCode](https://opencode.ai) — `opencode auth login`

Without a signer key, T3 Trade runs in **read-only mode**. You can create
missions, watch markets, and review the agent's proposed actions, but T3 Trade
will not sign or submit orders.

## The interim signer key

Hyperliquid requires every order to be signed by a key that controls the
account. T3 Trade does not yet include wallet onboarding or scoped agent-key
management. Testnet execution currently uses one **interim signer key** that
you provide. The presence of this key enables order execution:

- Place it at `~/.t3trade/secrets/hyperliquid-interim-signer-key.bin`. You can
  override the base directory with `T3TRADE_HOME` or set
  `T3_TRADES_INTERIM_SIGNER_KEY`. The dev server, worktrees, and packaged
  desktop app all use this location.
- **With the key, the server can place testnet orders. Without the key, the
  server is read-only.** There is no additional execution flag.
- The key never appears in logs, reports, or the database, and must never be
  committed. Use a testnet-funded key only.

This alpha uses one key and one configuration path. Expanded key management is
not yet available.

## Safety model

- **Testnet only.** No mainnet configuration exists.
- **The signer key enables order execution.** See above.
- **`T3_TRADES_LIVE_EXECUTION=1` enables live smoke tests only.** The
  `packages/hyperliquid` test suite reads it; the server does not.
- **Leave the account with no open exposure.** After a live run, close the
  position and cancel resting orders.

## Layout

| Path                                     | What lives there                                           |
| ---------------------------------------- | ---------------------------------------------------------- |
| `packages/trading-contracts`             | Schemas and rules for order previews, protection, and risk |
| `packages/hyperliquid`                   | The exchange client: signing, info reads, WebSocket        |
| `apps/server/src/trading`                | Mission state machine, execution, reconciliation, controls |
| `apps/web/src/components/trading`        | Mission workspace and risk controls                        |
| `apps/marketing`                         | The T3 Trade site                                          |
| `docs/architecture/trading-execution.md` | Design notes for the execution path                        |
| `docs/upstream/`                         | Upstream baseline, patch ledger, and sync runbook          |

Code outside these paths comes from T3 Code and stays close to upstream to
reduce sync work. See
[`docs/upstream/PATCH_LEDGER.md`](./docs/upstream/PATCH_LEDGER.md) for each
intentional difference.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Trading execution and reconciliation](./docs/architecture/trading-execution.md)
- [Architecture overview](./docs/internals/overview.md)
- [Upstream baseline and sync runbook](./docs/upstream/SYNC_RUNBOOK.md)
- [Glossary](./docs/internals/glossary.md)

## Upstream

T3 Trade tracks `pingdotgg/t3code` at the commit listed in
[`docs/upstream/BASELINE.md`](./docs/upstream/BASELINE.md). The `upstream`
remote is fetch-only. For non-trading features, use T3 Code's README, install
instructions, and support channels. This fork does not accept contributions
that belong in the upstream project.
