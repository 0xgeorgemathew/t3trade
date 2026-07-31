import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationTradingMission, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

function tradingMissionSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingMissionSnapshot({ environmentId, input: {} });
}

export function refreshTradingMissions(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(tradingMissionSnapshotAtom(environmentId));
}

export interface TradingMissionsState {
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

/**
 * The trading missions projected for one environment.
 *
 * Everything here comes from `projection_trading_missions`, which the trading
 * projector rebuilds from the event stream. There is no client-side mission
 * state to go stale, and nothing is synthesized when the projection is empty.
 */
export function useTradingMissions(environmentId: EnvironmentId): TradingMissionsState {
  const result = useAtomValue(tradingMissionSnapshotAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));

  const refresh = useCallback(() => {
    refreshTradingMissions(environmentId);
  }, [environmentId]);

  return {
    missions: snapshot?.missions ?? [],
    error: result._tag === "Failure" ? "Failed to load trading missions." : null,
    isLoading: result.waiting,
    refresh,
  };
}

/**
 * The single mission bound to a thread, if any (§10.2: one active mission per
 * thread). Client-side filter over the environment snapshot — the projection
 * already carries `threadId`, so no contract change is needed for Phase 2.
 *
 * Returns `null` when the thread has no bound mission (the common case for
 * non-trading threads); the caller gates the UI on that.
 */
export function useTradingMissionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): OrchestrationTradingMission | null {
  const { missions } = useTradingMissions(environmentId);
  return missions.find((m) => m.threadId === threadId) ?? null;
}
