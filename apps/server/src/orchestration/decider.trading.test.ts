import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TradingMissionId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TRADING_CONTROL_TARGET_STATUS } from "./commandInvariants.ts";
import { decideOrchestrationCommand } from "./decider.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

/** Every trading command decides to exactly one event; unwrap it with narrowing. */
function singleEvent(result: PlannedEvent | ReadonlyArray<PlannedEvent>): PlannedEvent {
  assert.ok(!Array.isArray(result), "expected exactly one planned event");
  return result as PlannedEvent;
}

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const MISSION_ID = TradingMissionId.make("mission-1");

function makeReadModel(archivedAt: string | null = null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("trading decider", (it) => {
  it.effect("turns a mission create into a request, not a created fact", () =>
    Effect.gen(function* () {
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "trading.mission.create",
            commandId: CommandId.make("cmd-create"),
            threadId: THREAD_ID,
            missionId: MISSION_ID,
            tradingAccountId: "acct-1",
            instruction: "Trade ETH momentum",
            allocatedCapitalUsd: 1_000,
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );

      expect(event.type).toBe("trading.mission-create-requested");
      expect(event.aggregateKind).toBe("mission");
      expect(event.aggregateId).toBe(MISSION_ID);
      expect(event.payload).toMatchObject({
        missionId: MISSION_ID,
        threadId: THREAD_ID,
        allocatedCapitalUsd: 1_000,
        requestedAt: NOW,
      });
    }),
  );

  it.effect("refuses to start a mission on an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "trading.mission.create",
          commandId: CommandId.make("cmd-create-archived"),
          threadId: THREAD_ID,
          missionId: MISSION_ID,
          tradingAccountId: "acct-1",
          instruction: "Trade ETH momentum",
          allocatedCapitalUsd: 1_000,
          createdAt: NOW,
        },
        readModel: makeReadModel("2025-12-31T00:00:00.000Z"),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("maps every Phase 1 control to its §11.1 destination status", () =>
    Effect.gen(function* () {
      for (const [control, targetStatus] of Object.entries(TRADING_CONTROL_TARGET_STATUS)) {
        const event = singleEvent(
          yield* decideOrchestrationCommand({
            command: {
              type: control as "trading.mission.pause",
              commandId: CommandId.make(`cmd-${control}`),
              threadId: THREAD_ID,
              missionId: MISSION_ID,
              createdAt: NOW,
            },
            readModel: makeReadModel(),
          }),
        );

        expect(event.type).toBe("trading.mission-control-requested");
        expect(event.payload).toMatchObject({ control, targetStatus });
      }
    }),
  );

  it.effect("records a server-decided transition verbatim, blockedReason and all", () =>
    Effect.gen(function* () {
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "trading.mission.status-set",
            commandId: CommandId.make("cmd-blocked"),
            threadId: THREAD_ID,
            missionId: MISSION_ID,
            status: "blocked",
            blockedReason: "protection_failure",
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );

      expect(event.type).toBe("trading.mission-status-changed");
      expect(event.payload).toMatchObject({
        status: "blocked",
        blockedReason: "protection_failure",
      });
    }),
  );

  it.effect("carries a strategy publication through as an event", () =>
    Effect.gen(function* () {
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "trading.mission.strategy-published",
            commandId: CommandId.make("cmd-publish"),
            threadId: THREAD_ID,
            missionId: MISSION_ID,
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );

      expect(event.type).toBe("trading.mission-strategy-published");
      // Plan 29 step 4.2: a publication revises in place — no version number
      // and no superseded watch ids ride the event any more.
      expect(event.payload).toMatchObject({ missionId: MISSION_ID, threadId: THREAD_ID });
      expect("strategyVersion" in event.payload).toBe(false);
      expect("supersededWatchIds" in event.payload).toBe(false);
    }),
  );
});
