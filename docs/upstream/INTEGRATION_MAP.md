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
