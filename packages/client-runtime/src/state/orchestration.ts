import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import * as Crypto from "effect/Crypto";

import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import {
  type TradingMissionControlInput,
  type TradingMissionCreateInput,
  type TradingRiskControlInput,
  tradingMissionControl,
  tradingMissionCreate,
  tradingRiskControl,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type { TradingMissionControlInput, TradingMissionCreateInput, TradingRiskControlInput };

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    tradingMissionSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-mission-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getTradingMissionSnapshot,
    }),
    tradingMarketChart: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-market-chart",
      tag: ORCHESTRATION_WS_METHODS.getTradingMarketChart,
    }),

    // §14.7's deterministic controls. Ordinary environment commands: a
    // workspace button dispatches straight to the server, which is the whole
    // point — no harness turn stands between the press and the action.
    missionControl: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:mission-control",
      execute: (input: TradingMissionControlInput) => tradingMissionControl(input),
    }),
    riskControl: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:risk-control",
      execute: (input: TradingRiskControlInput) => tradingRiskControl(input),
    }),
    missionCreate: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:mission-create",
      execute: (input: TradingMissionCreateInput) => tradingMissionCreate(input),
    }),
  };
}
