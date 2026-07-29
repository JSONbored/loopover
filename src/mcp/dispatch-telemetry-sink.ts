// The remote server's PostHog + OTel sink for dispatch telemetry (#9525).
//
// Separated from the wrapper in dispatch-telemetry.ts so the decision logic stays pure and testable
// while this file owns the I/O and the gates. Both events, the exception capture, and the span all
// go through here.
//
// GATES ARE UNCHANGED by this issue: the usage events keep POSTHOG_API_KEY (#6228/#6235), the
// exception capture keeps WORKER_POSTHOG_API_KEY (#8288). Those two are deliberately separate --
// src/api/worker-posthog.ts explains why at length -- and #9525 does not merge them, because doing
// so would silently activate Worker exception capture inside a self-hoster's Node process the
// moment they set the MCP telemetry key.
//
// posthog-node rather than a hand-built $exception payload: PostHog's own docs warn that a
// hand-constructed exception event "fails in the vast majority of cases because the exception event
// schema is strict", and this Worker already bundles posthog-node for #6235, so there is no bundle
// argument for avoiding it here. (#9525's issue text assumed metagraphed's situation, where the
// bundle cost was real.)
import { capturePostHogWorkerError, isWorkerPostHogConfigured, type WorkerPostHogEnv } from "../api/worker-posthog";
import { MCP_TOOL_CALL_EVENT, MCP_USAGE_EVENT } from "@loopover/contract";
import type { DispatchTelemetrySink } from "./dispatch-telemetry";
import { getMcpDispatchSpanRunner } from "./dispatch-span-registry";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Anonymous, constant distinct id: this fleet telemetry carries NO per-actor identity by design
 *  (#6228), matching src/mcp/telemetry.ts's identical choice. */
const MCP_TELEMETRY_DISTINCT_ID = "loopover-mcp";

export type DispatchTelemetryEnv = Pick<Env, "POSTHOG_API_KEY" | "POSTHOG_HOST"> & WorkerPostHogEnv;

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Deferred work the caller schedules via `waitUntil`, so a slow flush never delays the response. */
export type DeferWork = (work: Promise<unknown>) => void;

/** Only ever reached from behind `recordToolCall`'s gate, so it takes the resolved key rather than
 *  re-deriving and re-checking it -- a second guard here would be unreachable by construction. */
async function captureEvents(
  env: DispatchTelemetryEnv,
  apiKey: string,
  properties: { usage: Record<string, unknown>; mcpToolCall: Record<string, unknown> },
): Promise<void> {
  try {
    const { PostHog } = await import("posthog-node");
    const client = new PostHog(apiKey, {
      host: trimmedOrUndefined(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
      // Required for an edge/per-request lifecycle: batched data is sent asynchronously and the
      // isolate can be torn down before it lands.
      flushAt: 1,
      flushInterval: 0,
    });
    for (const [event, props] of [
      [MCP_USAGE_EVENT, properties.usage],
      [MCP_TOOL_CALL_EVENT, properties.mcpToolCall],
    ] as const) {
      client.capture({ distinctId: MCP_TELEMETRY_DISTINCT_ID, event, properties: props, disableGeoip: true });
    }
    await client.flush();
  } catch {
    // Best-effort by contract: a PostHog init/capture/flush failure records nothing, exactly like
    // the unconfigured path.
  }
}

/**
 * Build the sink for one request.
 *
 * `withSpan` is injected rather than imported so the Worker build never pulls the self-host OTel
 * module into its bundle: the self-host entry passes its real `withOtelSpan`, and the Worker path
 * passes nothing and gets a passthrough.
 */
export function createDispatchTelemetrySink(
  env: DispatchTelemetryEnv,
  defer: DeferWork,
  withSpan?: <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>,
): DispatchTelemetrySink {
  return {
    recordToolCall: (_call, properties) => {
      const apiKey = trimmedOrUndefined(env.POSTHOG_API_KEY);
      if (!apiKey) return;
      defer(captureEvents(env, apiKey, properties));
    },
    captureException: (error, call) => {
      if (!isWorkerPostHogConfigured(env)) return;
      // `mcp_tool` + `error_code` are the grouping properties: an exception dashboard broken down by
      // tool and cause is the thing an operator can act on, unlike a stack-only view.
      defer(capturePostHogWorkerError(env, error, { path: `mcp.tool/${call.tool}`, method: call.errorCode ?? "unknown_error" }));
    },
    // The registry is consulted per call rather than captured at construction so a self-host boot
    // that fills the slot after the first request still traces.
    withSpan: (name, attributes, fn) => (withSpan ?? getMcpDispatchSpanRunner() ?? ((_n, _a, run) => run()))(name, attributes, fn),
  };
}
