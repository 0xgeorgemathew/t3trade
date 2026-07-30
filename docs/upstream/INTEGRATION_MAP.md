# Integration Map

What T3 Code (upstream, pinned at `docs/upstream/BASELINE.md`) already
provides, and the narrow seams later trading phases (PROMPT-01 onward) are
expected to extend rather than rewrite. This is a map for humans doing
sync-conflict triage and phase planning, not an exhaustive architecture doc
— see `architecture.html` §6.2 for the authoritative package-layout spec.

## What upstream already is

T3 Code is a multi-surface client for coding agents (Claude Code, Codex,
Cursor CLI, Grok CLI, OpenCode): a local server that supervises agent
sessions against a git workspace, a desktop app (Electron) and web app that
talk to it over RPC, and a mobile app for remote monitoring/control.

| Layer            | Package(s)                                                                                   | Role                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server runtime   | `apps/server`                                                                                | Hosts sessions, git/VCS state, provider processes; exposes RPC over `apps/server/src/ws.ts` / `http.ts`                                                                                                                          |
| Desktop shell    | `apps/desktop`                                                                               | Electron app; supervises a local server, owns updates/signing/OS integration                                                                                                                                                     |
| Web UI           | `apps/web`                                                                                   | Chat/thread UI, settings, file browser, preview — talks to the server over the same RPC contracts desktop uses                                                                                                                   |
| Mobile           | `apps/mobile`                                                                                | Remote monitoring/control client (Expo/React Native)                                                                                                                                                                             |
| Marketing site   | `apps/marketing`                                                                             | Astro; unrelated to runtime, unlikely to need trading-aware changes                                                                                                                                                              |
| Shared contracts | `packages/contracts`                                                                         | Effect `Schema` definitions for every RPC message, environment descriptor, settings shape, etc. — the seam every new feature that crosses the client/server boundary must extend                                                 |
| Client runtime   | `packages/client-runtime`                                                                    | Typed RPC client built on `packages/contracts`; used by web, desktop, mobile                                                                                                                                                     |
| Shared utilities | `packages/shared`                                                                            | Cross-cutting helpers (git, logging, settings, relay client, dev-home resolution) with no UI or server dependency                                                                                                                |
| Provider drivers | `apps/server/src/provider/Drivers/*Driver.ts`, `apps/server/src/provider/Layers/*Adapter.ts` | One driver + adapter pair per supported coding agent (Claude, Codex, Cursor, Grok, OpenCode); this is the extension point the roadmap's "per-provider conformance for Codex, Claude, OpenCode" (acceptance outcome 9) plugs into |
| Remote relay     | `infra/relay`, `packages/tailscale`, `packages/ssh`                                          | Cross-machine access, tunneling, remote environments                                                                                                                                                                             |

## Path-level inventory

The table above is a layer-level map; this is the path-level inventory of
the specific upstream seams later phases are most likely to touch or
extend. Update this table (not just the narrative above) as new seams are
identified.

| Path                                                            | What it is                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/ws.ts`                                         | RPC transport (WebSocket) server/web/desktop/mobile clients connect over                                         |
| `apps/server/src/provider/Layers/ProviderService.ts`            | Provider-layer service wiring (Effect `Layer`) for the per-agent driver/adapter seam                             |
| `apps/server/src/provider/Services/ProviderService.ts`          | Provider service interface/implementation consumed by the layer above                                            |
| `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`   | Tracks live provider sessions per project/thread at the layer boundary                                           |
| `apps/server/src/provider/Services/ProviderSessionDirectory.ts` | Provider session directory service interface/implementation                                                      |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`   | Orchestration layer wiring for the decide/project event loop                                                     |
| `apps/server/src/orchestration/Services/OrchestrationEngine.ts` | Orchestration engine service interface/implementation                                                            |
| `apps/server/src/orchestration/decider.ts`                      | Pure decision function: current state + command → events, for thread/mission orchestration                       |
| `apps/server/src/orchestration/projector.ts`                    | Pure projection function: events → read-model state                                                              |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`    | Layer wiring the projector into the persisted/broadcast event pipeline                                           |
| `apps/server/src/orchestration/Services/ProjectionPipeline.ts`  | Projection pipeline service interface/implementation                                                             |
| `apps/server/src/persistence/Migrations.ts`                     | SQLite schema migrations; any new persisted state (e.g. mission/trading tables) adds here                        |
| `apps/server/src/mcp/McpHttpServer.ts`                          | MCP server entrypoint exposed to external MCP clients                                                            |
| `apps/server/src/mcp/McpSessionRegistry.ts`                     | Tracks live MCP client sessions                                                                                  |
| `apps/server/src/mcp/McpInvocationContext.ts`                   | Per-invocation context (auth, project scope) threaded through MCP tool calls                                     |
| `packages/shared/src/DrainableWorker.ts`                        | Background worker primitive that finishes in-flight work before shutdown                                         |
| `packages/shared/src/KeyedCoalescingWorker.ts`                  | Background worker primitive that coalesces repeated work by key (e.g. per-thread projection)                     |
| `AGENTS.md`                                                     | Repo-root agent operating instructions (changed in #4782); any new agent-facing surface should keep this current |

## Where trading is additive, not a rewrite

Per PROMPT-00's constraints (preserve upstream services, extend via new
product-owned packages), later phases should land as:

- **New workspace-level packages** (e.g. a `packages/trading-*` family) for
  the mission runtime, Hyperliquid adapter, risk/reservation logic, and
  conversational-control interpretation described in PROMPT-01 through
  PROMPT-07 — analogous to how `packages/tailscale`/`packages/ssh` sit
  beside `packages/shared` today without upstream depending on them.
- **New contracts modules** under `packages/contracts/src/` (its own file,
  re-exported from `index.ts` the same way `resourceTelemetry.ts` or
  `background.ts` were added upstream) for any new RPC surface (mission
  state, market data snapshots, control-button commands) — this keeps the
  server/web/desktop/mobile clients in sync through the existing typed-RPC
  seam instead of a parallel channel.
- **New server-side services** under `apps/server/src/` alongside, not
  replacing, `provider/`, `vcs/`, `background/` — e.g. a `trading/` or
  `mission/` directory, wired into `apps/server/src/server.ts` /
  `bootstrap.ts` the same way `resourceTelemetry/` was added.
- **New UI routes/components** under `apps/web/src/routes` and
  `apps/web/src/components`, following the existing `settings.*.tsx` /
  `_chat.*.tsx` route conventions, rather than restructuring routing.
- **Provider-conformance tests** live next to the existing
  `apps/server/src/provider/Layers/*Provider.test.ts` pattern — Phase 8's
  "per-provider conformance for Codex, Claude, OpenCode" gate is a natural
  extension of the adapter test suite that already exists per provider.

## Known upstream seams likely to see sync conflicts

Recorded in `docs/upstream/PATCH_LEDGER.md` and kept current there as
phases land; as of PROMPT-00 the only touched seams are desktop branding
(app ID, product name, artifact naming) — see the ledger for the full list
and the identifiers deliberately left unchanged.
