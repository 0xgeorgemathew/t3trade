import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentActivation,
} from "@t3tools/contracts";

export interface OrchestrationV2SubagentPhaseGroup {
  readonly index: number;
  readonly title: string;
  readonly status: "pending" | "running" | "done";
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}

export interface OrchestrationV2SubagentGroup {
  readonly workflow: OrchestrationV2Subagent | null;
  readonly phases: ReadonlyArray<OrchestrationV2SubagentPhaseGroup>;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}

export interface OrchestrationV2SubagentPanelState {
  readonly groups: ReadonlyArray<OrchestrationV2SubagentGroup>;
  readonly activationsBySubagentId: ReadonlyMap<
    string,
    ReadonlyArray<OrchestrationV2SubagentActivation>
  >;
  readonly activeCount: number;
  readonly waitingCount: number;
  readonly settledCount: number;
  readonly totalTokens: number | null;
}

export const isSettledOrchestrationV2Subagent = (agent: OrchestrationV2Subagent) =>
  agent.status === "idle" ||
  agent.status === "completed" ||
  agent.status === "failed" ||
  agent.status === "cancelled" ||
  agent.status === "interrupted";

const phaseStatus = (agents: ReadonlyArray<OrchestrationV2Subagent>) =>
  agents.length === 0
    ? ("pending" as const)
    : agents.every(isSettledOrchestrationV2Subagent)
      ? ("done" as const)
      : ("running" as const);

export function deriveOrchestrationV2SubagentPanelState(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly activations: ReadonlyArray<OrchestrationV2SubagentActivation>;
}): OrchestrationV2SubagentPanelState {
  const activationsBySubagentId = new Map<string, OrchestrationV2SubagentActivation[]>();
  for (const activation of input.activations) {
    const current = activationsBySubagentId.get(activation.subagentId) ?? [];
    current.push(activation);
    activationsBySubagentId.set(activation.subagentId, current);
  }
  for (const activations of activationsBySubagentId.values()) {
    activations.sort((left, right) => left.ordinal - right.ordinal);
  }

  const workflows = input.subagents.filter((agent) => agent.kind === "workflow");
  const membersByWorkflow = new Map<string, OrchestrationV2Subagent[]>();
  const direct: OrchestrationV2Subagent[] = [];
  for (const agent of input.subagents) {
    if (agent.kind === "workflow") continue;
    const workflowId = agent.workflowMembership?.workflowSubagentId;
    if (workflowId === undefined) {
      direct.push(agent);
      continue;
    }
    const members = membersByWorkflow.get(workflowId) ?? [];
    members.push(agent);
    membersByWorkflow.set(workflowId, members);
  }

  const groups: OrchestrationV2SubagentGroup[] = workflows.map((workflow) => {
    const members = membersByWorkflow.get(workflow.id) ?? [];
    membersByWorkflow.delete(workflow.id);
    const phases = (workflow.workflow?.phases ?? []).map((phase) => {
      const agents = members
        .filter((agent) => agent.workflowMembership?.phaseIndex === phase.index)
        .toSorted(
          (left, right) =>
            (left.workflowMembership?.agentIndex ?? 0) -
            (right.workflowMembership?.agentIndex ?? 0),
        );
      return { ...phase, status: phaseStatus(agents), agents };
    });
    const phasedIds = new Set(phases.flatMap((phase) => phase.agents.map((agent) => agent.id)));
    return {
      workflow,
      phases,
      agents: members.filter((agent) => !phasedIds.has(agent.id)),
    };
  });
  for (const orphaned of membersByWorkflow.values()) direct.push(...orphaned);
  if (direct.length > 0) groups.push({ workflow: null, phases: [], agents: direct });

  const workers = input.subagents.filter((agent) => agent.kind !== "workflow");
  // A coordinator's usage already includes its members', so counting both
  // double-reports the thread. Only drop it when the members actually account
  // for it: a provider that reports workflow usage but omits per-agent tokens
  // would otherwise erase the whole workflow from the total.
  const memberTotalsByWorkflow = new Map<string, number>();
  for (const agent of workers) {
    const workflowId = agent.workflowMembership?.workflowSubagentId;
    if (workflowId === undefined) continue;
    memberTotalsByWorkflow.set(
      workflowId,
      (memberTotalsByWorkflow.get(workflowId) ?? 0) + (agent.usage?.totalTokens ?? 0),
    );
  }
  const reportedUsage = input.subagents.flatMap((agent) => {
    if (agent.usage === null) return [];
    if (agent.kind !== "workflow") return [agent.usage.totalTokens];
    const memberTotal = memberTotalsByWorkflow.get(agent.id);
    if (memberTotal === undefined) return [agent.usage.totalTokens];
    // Keep whatever the members did not account for. Dropping the coordinator
    // outright erases the whole workflow whenever a provider reports its usage
    // but omits per-agent tokens.
    return memberTotal >= agent.usage.totalTokens ? [] : [agent.usage.totalTokens - memberTotal];
  });
  // Count the workers, plus any coordinator that has no members yet. A
  // coordinator with members is represented by them and would double-count;
  // one without is the only row on the thread, and omitting it reported
  // "0 active" while a workflow was visibly running.
  const counted = input.subagents.filter(
    (agent) => agent.kind !== "workflow" || !memberTotalsByWorkflow.has(agent.id),
  );
  return {
    groups,
    activationsBySubagentId,
    activeCount: counted.filter((agent) => agent.status === "pending" || agent.status === "running")
      .length,
    waitingCount: counted.filter((agent) => agent.status === "waiting").length,
    settledCount: counted.filter(isSettledOrchestrationV2Subagent).length,
    totalTokens:
      reportedUsage.length === 0
        ? null
        : reportedUsage.reduce((total, tokens) => total + tokens, 0),
  };
}

export const formatSubagentTokenCount = (totalTokens: number) =>
  totalTokens >= 999_500
    ? `${(totalTokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : totalTokens >= 1_000
      ? `${(totalTokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`
      : String(totalTokens);
