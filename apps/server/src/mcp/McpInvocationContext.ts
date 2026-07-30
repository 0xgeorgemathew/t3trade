import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "trading";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The credential identity a capability denial reports. */
export interface McpCapabilityDenial {
  readonly capability: McpCapability;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/**
 * The capability gate every toolkit handler runs first.
 *
 * Each toolkit supplies the error its own tools declare, so a denial stays
 * inside that toolkit's published failure union instead of leaking another
 * toolkit's error type to the agent.
 */
export const requireCapability = <E>(
  capability: McpCapability,
  onDenied: (denial: McpCapabilityDenial) => E,
): Effect.Effect<McpInvocationScope, E, McpInvocationContext> =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (invocation.capabilities.has(capability)) return invocation;
    return yield* Effect.fail(
      onDenied({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      }),
    );
  }).pipe(Effect.withSpan("mcp.requireCapability"));

/** The preview toolkit's gate, failing with the error its tools declare. */
export const requireMcpCapability = (
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext> =>
  requireCapability(
    capability,
    (denial) => new PreviewAutomationUnavailableError({ ...denial, capability }),
  );
