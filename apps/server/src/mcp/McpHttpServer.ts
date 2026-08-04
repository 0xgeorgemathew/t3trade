import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { coerceToolArguments } from "./coerceToolArguments.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { TradingToolkitHandlersLive } from "./toolkits/trading/handlers.ts";
import { TradingToolkit } from "./toolkits/trading/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-trade` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

/**
 * What `McpServer` returns for anything that is not a declared tool failure.
 *
 * Mirrors the private constant in effect's `McpServer.registerToolkit` so this
 * boundary reports the same generic string the upstream registration does.
 */
const INTERNAL_TOOL_ERROR_MESSAGE = "Tool execution failed due to an internal server error.";

const toolErrorResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

/**
 * Register a toolkit with argument coercion at the boundary.
 *
 * This is effect's `McpServer.registerToolkit`
 * (`node_modules/.../effect/dist/unstable/ai/McpServer.js`, `registerToolkit`)
 * with exactly one change: the payload handed to `built.handle` is first run
 * through `coerceToolArguments` against the tool's own JSON schema, so a
 * provider that emits `"100"` for a number or `"true"` for a boolean does not
 * lose the whole call to `Invalid parameters for tool`. The advertised schema
 * stays strict; coercion only rewrites values that honestly satisfy the
 * declared type, so genuinely wrong input still fails validation downstream.
 *
 * The failure mapping is reproduced verbatim: a declared tool failure's message
 * passes through, an `AiError.ToolParameterValidationError` reason's message
 * passes through, and everything else collapses to the generic internal-error
 * string. Trading is the scope — the preview toolkits keep `McpServer.toolkit`.
 */
const registerToolkitLenient = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
) {
  const registry = yield* McpServer.McpServer;
  const built = yield* toolkit;
  const services = yield* Effect.context();
  for (const tool of Object.values(built.tools)) {
    const annotations = tool.annotations;
    const toolMeta = Context.getOrUndefined(annotations, Tool.Meta);
    const isDeclaredFailure = Schema.is(tool.failureSchema);
    const inputSchema = Tool.getJsonSchema(tool);
    yield* registry.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema,
        annotations: {
          ...Context.getOption(annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(annotations, Tool.Readonly),
          destructiveHint: Context.get(annotations, Tool.Destructive),
          idempotentHint: Context.get(annotations, Tool.Idempotent),
          openWorldHint: Context.get(annotations, Tool.OpenWorld),
        },
        _meta: toolMeta,
      }),
      annotations,
      handle: (payload: unknown) =>
        built
          .handle(
            tool.name,
            // Coercion returns `unknown`; the toolkit's handle expects the
            // tool's decoded input type. The cast mirrors the upstream
            // registration, which receives `payload: any` — coercion only
            // rewrites values that satisfy the schema, so validation below is
            // unchanged.
            coerceToolArguments(inputSchema, payload) as never,
          )
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideContext(services),
            Effect.map(
              (result) =>
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent:
                    typeof result.encodedResult === "object"
                      ? (result.encodedResult as Record<string, unknown>)
                      : undefined,
                  content: [{ type: "text", text: JSON.stringify(result.encodedResult) }],
                }),
            ),
            Effect.tapCause(Effect.logError),
            Effect.catch((error: unknown) => {
              if (AiError.isAiError(error)) {
                const reason = error.reason;
                return Effect.succeed(
                  reason._tag === "ToolParameterValidationError"
                    ? toolErrorResult(reason.message)
                    : toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE),
                );
              }
              if (isDeclaredFailure(error)) {
                const message =
                  error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE;
                return Effect.succeed(toolErrorResult(message));
              }
              return Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE));
            }),
            Effect.catchDefect(() => Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE))),
          ),
    });
  }
});

export const TradingToolkitRegistrationLive = Layer.effectDiscard(
  registerToolkitLenient(TradingToolkit),
).pipe(Layer.provide(TradingToolkitHandlersLive));

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Trade",
  version: packageJson.version,
  path: "/mcp",
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  TradingToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
