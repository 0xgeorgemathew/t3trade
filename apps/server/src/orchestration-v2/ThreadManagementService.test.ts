import { expect, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import {
  existingThreadIdsForCommand,
  userFacingShellSnapshot,
  withCreationProvenance,
} from "./ThreadManagementService.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("removes internal subagent children from active and archived shell collections", () => {
  const rootId = ThreadId.make("thread:thread-management:root");
  const forkId = ThreadId.make("thread:thread-management:fork");
  const lineageSubagentId = ThreadId.make("thread:thread-management:lineage-subagent");
  const nodeSubagentId = ThreadId.make("thread:thread-management:node-subagent");
  const shell = (
    id: ThreadId,
    lineage: OrchestrationV2ThreadShell["lineage"],
    forkedFrom: OrchestrationV2ThreadShell["forkedFrom"],
  ) =>
    ({
      id,
      lineage,
      forkedFrom,
    }) as OrchestrationV2ThreadShell;
  const rootLineage = {
    rootThreadId: rootId,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;
  const snapshot = userFacingShellSnapshot({
    schemaVersion: 3,
    snapshotSequence: 10,
    threads: [
      shell(rootId, rootLineage, null),
      shell(
        forkId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
        },
        { type: "run", threadId: rootId, runId: RunId.make("run:thread-management:fork") },
      ),
      shell(
        lineageSubagentId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
        null,
      ),
    ],
    archivedThreads: [
      shell(nodeSubagentId, rootLineage, {
        type: "node",
        nodeId: NodeId.make("node:thread-management:subagent"),
      }),
    ],
  });

  expect(snapshot.threads.map((thread) => thread.id)).toEqual([rootId, forkId]);
  expect(snapshot.archivedThreads).toEqual([]);
});
