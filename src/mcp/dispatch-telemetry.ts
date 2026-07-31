// The remote server's tool-dispatch telemetry chokepoint (#9525).
//
// Every `tools/call` the remote server answers passes through `instrumentToolDispatch` exactly
// once, whether it returns, returns an error envelope, or throws. That is the whole point of a
// chokepoint: ~116 handlers stay untouched, and there is one place where the decision "what does a
// tool call emit" is made.
//
// WHAT IT EMITS, all of it defined in @loopover/contract so the three servers cannot drift:
//   - the minimal `usage_event` (tool, category, surface, ok, duration, closed error code);
//   - PostHog's `$mcp_tool_call`, which additionally carries REDACTED, size-capped arguments and
//     results -- except for tools the contract marks as carrying operator data, where both are
//     excluded outright and the event says so;
//   - a `$exception` capture for a genuine throw (an error ENVELOPE is a tool answering, not a
//     crash, and is not an exception);
//   - an OTel span `mcp.tool/<name>` on the self-host path, whose attributes are a strict subset --
//     never arguments.
//
// SAFE BY CONSTRUCTION: every sink is gated and best-effort, and this wrapper catches everything it
// does. Telemetry must never turn a working tool call into a failed one.
import {
  buildMcpToolCallProperties,
  type McpAnalyticsContext,
  buildMcpToolSpanAttributes,
  buildUsageEventProperties,
  getToolContract,
  mcpToolSpanName,
  resolveErrorCode,
  toolErrorEnvelope,
  toolExcludesPayloads,
  UNKNOWN_TOOL_CATEGORY,
  type McpToolCallTelemetry,
} from "@loopover/contract";

/** One structured log line, matching the `{level, event, ...}` JSON shape the rest of this codebase
 *  writes (src/auth/rate-limit.ts, src/selfhost/queue-common.ts) and the self-host Loki pipeline
 *  already parses. Only the closed property set is ever logged -- no payload content. */
function log(level: "warn" | "error", event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else console.warn(line);
}

/** The shape a tool handler returns. `isError` distinguishes "the tool answered no" from a throw. */
type ToolResultLike = { isError?: boolean; structuredContent?: unknown } | undefined;

export type DispatchTelemetrySink = {
  /** Both usage events. Never throws. */
  recordToolCall: (call: McpToolCallTelemetry, properties: { usage: Record<string, unknown>; mcpToolCall: Record<string, unknown> }) => void;
  /** A genuine throw. Never throws. */
  captureException: (error: unknown, call: McpToolCallTelemetry) => void;
  /** Wrap the call in a span when tracing is on; a no-op passthrough when it is not. */
  withSpan: <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;
  /**
   * Session/server/client identity for the canonical `$mcp_*` events (#10175).
   *
   * On the SINK rather than threaded through every handler because it is per-REQUEST, not per-call:
   * the remote server already builds one sink per request (so deferred work rides that request's
   * `waitUntil`), which is exactly the scope an MCP session id has. Optional so the stdio and miner
   * sinks, which have no HTTP session, can omit it.
   */
  context?: McpAnalyticsContext;
};

/** A sink that does nothing, used when nothing is configured. Exported for tests. */
export const NOOP_DISPATCH_SINK: DispatchTelemetrySink = {
  recordToolCall: () => undefined,
  captureException: () => undefined,
  withSpan: async (_name, _attributes, fn) => fn(),
};

function describe(toolName: string): { category: string; excluded: boolean } {
  const contract = getToolContract(toolName);
  /* v8 ignore next -- the contract validator (#9520) makes an unregistered name impossible; this
     branch exists so telemetry can never throw on the path it instruments. */
  if (!contract) return { category: UNKNOWN_TOOL_CATEGORY, excluded: true };
  return { category: contract.category, excluded: toolExcludesPayloads(contract) };
}

/**
 * Wrap one tool handler with dispatch telemetry.
 *
 * `ok` follows the CALLER-VISIBLE outcome: a handler that reports failure by returning an error
 * envelope did not succeed, even though it never threw. That matches what the HTTP-level telemetry
 * has always recorded (`response.status < 400`) so the two views of the same call agree.
 */
export function instrumentToolDispatch<TArgs extends unknown[], TResult extends ToolResultLike>(
  toolName: string,
  sink: DispatchTelemetrySink,
  handler: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const { category, excluded } = describe(toolName);
    const startedAt = Date.now();
    const attributes = { tool: toolName, category, surface: "remote" as const };

    const emit = (call: McpToolCallTelemetry, payloads: { arguments?: unknown; result?: unknown }): void => {
      try {
        sink.recordToolCall(call, {
          usage: buildUsageEventProperties(call),
          mcpToolCall: buildMcpToolCallProperties(call, { ...payloads, excluded }, sink.context ?? {}),
        });
      } catch {
        // Telemetry must never surface into the tool caller.
      }
    };

    try {
      return await sink.withSpan(mcpToolSpanName(toolName), attributes, async () => {
        const result = await handler(...args);
        const ok = result?.isError !== true;
        const call: McpToolCallTelemetry = {
          tool: toolName,
          category,
          surface: "remote",
          ok,
          durationMs: Date.now() - startedAt,
          // #9659: the result's own envelope classifies the failure. `resolveErrorCode` validates the
          // declared code against the closed set and falls back to `unknown_error` for a result that
          // carries no envelope, or one whose code is not a member -- so a tool cannot widen the
          // dimension by inventing a code.
          ...(ok ? {} : { errorCode: resolveErrorCode(toolErrorEnvelope(result?.structuredContent)) }),
        };
        emit(call, { arguments: args[0], result: result?.structuredContent });
        if (!ok) {
          // One line per failed call, with the same closed property set and no payload content.
          log("warn", "mcp_tool_call_failed", buildMcpToolSpanAttributes(call));
        }
        return result;
      });
    } catch (error) {
      const call: McpToolCallTelemetry = {
        tool: toolName,
        category,
        surface: "remote",
        ok: false,
        durationMs: Date.now() - startedAt,
        errorCode: resolveErrorCode(error),
      };
      emit(call, { arguments: args[0] });
      try {
        sink.captureException(error, call);
      } catch {
        // Same guarantee on the crash path.
      }
      log("error", "mcp_tool_call_threw", buildMcpToolSpanAttributes(call));
      throw error;
    }
  };
}
