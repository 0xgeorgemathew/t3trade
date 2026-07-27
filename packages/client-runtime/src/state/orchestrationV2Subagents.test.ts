import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SubagentActivationId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentActivation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveOrchestrationV2SubagentPanelState,
  formatSubagentTokenCount,
} from "./orchestrationV2Subagents.ts";

const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
const threadId = ThreadId.make("thread-agents");
const runId = RunId.make("run-agents");
const workflowId = NodeId.make("workflow-1");

const agent = (
  id: string,
  input: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId,
  runId,
  parentNodeId: NodeId.make("root-node"),
  origin: "provider_native",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: "Work",
  title: id,
  model: "claude-opus-4-1",
  kind: "subagent",
  role: { name: "general-purpose", source: "provider" },
  status: "running",
  result: null,
  usage: null,
  currentActivationId: null,
  activationCount: 1,
  workflow: null,
  workflowMembership: null,
  recentActivity: [],
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  ...input,
});

const activation = (
  id: string,
  subagentId: OrchestrationV2Subagent["id"],
  ordinal: number,
): OrchestrationV2SubagentActivation => ({
  id: SubagentActivationId.make(id),
  threadId,
  subagentId,
  runId,
  providerTurnId: null,
  ordinal,
  status: "completed",
  usage: { totalTokens: ordinal * 100 },
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

describe("deriveOrchestrationV2SubagentPanelState", () => {
  it("groups workflow agents by phase without double-counting workflow usage", () => {
    const workflow = agent("workflow-1", {
      kind: "workflow",
      role: { name: "workflow-coordinator", source: "app_default" },
      status: "completed",
      usage: { totalTokens: 900 },
      workflow: {
        phases: [
          { index: 0, title: "Research" },
          { index: 1, title: "Implement" },
        ],
      },
    });
    const researcher = agent("researcher", {
      kind: "workflow_agent",
      usage: { totalTokens: 400 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const auditor = agent("auditor", {
      kind: "workflow_agent",
      status: "completed",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const implementer = agent("implementer", {
      kind: "workflow_agent",
      status: "idle",
      usage: { totalTokens: 500 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: 1,
        attempt: 1,
      },
    });
    const activations = [
      activation("activation-researcher-1", researcher.id, 1),
      activation("activation-researcher-2", researcher.id, 2),
    ];

    const result = deriveOrchestrationV2SubagentPanelState({
      subagents: [workflow, researcher, auditor, implementer],
      activations,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.phases.map((phase) => phase.title)).toEqual(["Research", "Implement"]);
    expect(result.groups[0]?.phases[0]?.agents).toEqual([auditor, researcher]);
    expect(result.activeCount).toBe(1);
    expect(result.settledCount).toBe(2);
    expect(result.totalTokens).toBe(900);
    expect(result.activationsBySubagentId.get(researcher.id)).toEqual(activations);
  });

  it("distinguishes unavailable usage from a reported zero", () => {
    const unavailable = deriveOrchestrationV2SubagentPanelState({
      subagents: [agent("unreported")],
      activations: [],
    });
    const reportedZero = deriveOrchestrationV2SubagentPanelState({
      subagents: [agent("reported-zero", { usage: { totalTokens: 0 } })],
      activations: [],
    });

    expect(unavailable.totalTokens).toBeNull();
    expect(reportedZero.totalTokens).toBe(0);
  });

  it("keeps workflow usage the members did not account for", () => {
    // A provider can report the workflow's own usage while omitting per-agent
    // tokens. Excluding the coordinator outright then erased the entire
    // workflow from the total and the header read "Usage unavailable".
    const workflow = agent("workflow-1", {
      kind: "workflow",
      status: "completed",
      usage: { totalTokens: 5000 },
      workflow: { phases: [] },
    });
    const silentMember = agent("silent-member", {
      kind: "workflow_agent",
      status: "completed",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: null,
        attempt: 1,
      },
    });
    const partialMember = agent("partial-member", {
      kind: "workflow_agent",
      status: "completed",
      usage: { totalTokens: 200 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: null,
        attempt: 1,
      },
    });

    expect(
      deriveOrchestrationV2SubagentPanelState({
        subagents: [workflow, silentMember],
        activations: [],
      }).totalTokens,
    ).toBe(5000);
    expect(
      deriveOrchestrationV2SubagentPanelState({
        subagents: [workflow, silentMember, partialMember],
        activations: [],
      }).totalTokens,
    ).toBe(5000);
  });

  it("counts a workflow that has no members yet", () => {
    // Before its members are spawned the coordinator is the only row on the
    // thread. Excluding it reported "0 active" while a workflow was visibly
    // running, with nothing listed to explain the tokens in the header.
    const running = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "running",
          usage: { totalTokens: 5000 },
          workflow: { phases: [{ index: 0, title: "Research" }] },
        }),
      ],
      activations: [],
    });

    expect(running.activeCount).toBe(1);
    expect(running.settledCount).toBe(0);
    expect(running.totalTokens).toBe(5000);
    expect(running.groups[0]?.workflow?.id).toBe(workflowId);
  });

  it("formats compact token counts", () => {
    expect(formatSubagentTokenCount(999)).toBe("999");
    expect(formatSubagentTokenCount(1_200)).toBe("1.2k");
    expect(formatSubagentTokenCount(999_999)).toBe("1M");
    expect(formatSubagentTokenCount(2_000_000)).toBe("2M");
  });
});
