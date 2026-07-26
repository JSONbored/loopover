import { PostHog } from "posthog-node";

// Local MCP telemetry wrapper (#6236, mirrors the remote wrapper from #6235). Same allowlisted event shape
// and PostHog vendor as src/mcp/telemetry.ts, so the two servers report consistent data -- the only real
// difference is the trust posture: this CLI runs on a user's own machine, so it is gated on an EXPLICIT,
// persisted opt-in flag rather than mere env-var presence. This module stays a pure helper like its lib/
// siblings (cli-error.js, format-table.js, ...) -- it never reads the CLI's config file itself. The caller
// (bin/loopover-mcp.js) resolves `telemetryEnabled` from the persisted config and passes it in.
//
// SAFE NO-OP: unless the caller passes `telemetryEnabled: true` AND LOOPOVER_MCP_POSTHOG_API_KEY is set,
// this records nothing and behaves byte-identically to before this module existed -- true for every user
// who has not run `loopover-mcp telemetry enable` (the default). It also never throws: a PostHog init/
// capture failure degrades to recording nothing, so it can never affect the CLI's actual command behavior.

/** PostHog US-cloud ingestion host -- the default when LOOPOVER_MCP_POSTHOG_HOST isn't set. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The PostHog event name every MCP tool call is recorded under (matches the remote wrapper, #6235). */
const MCP_TOOL_CALL_EVENT = "mcp_tool_call";

/** Anonymous, constant distinct id: this fleet telemetry carries NO per-actor identity by design (#6228),
 *  so every event shares one handle and there is no per-user person to build up. */
const MCP_TELEMETRY_DISTINCT_ID = "loopover-mcp";

export type RecordMcpToolCallOptions = { telemetryEnabled?: boolean };
export type McpToolCallEvent = { tool: string; callerType?: "local"; ok: boolean; durationMs: number };

/**
 * Record a single local MCP tool call to PostHog. Safe no-op unless `telemetryEnabled` is explicitly
 * `true` (the caller's resolved, persisted opt-in flag, default OFF -- #6236) AND
 * LOOPOVER_MCP_POSTHOG_API_KEY is configured; never throws.
 *
 * Returns a promise that resolves once the event has actually been flushed to PostHog (#8690) —
 * mirroring the remote `src/mcp/telemetry.ts` fix (#7233). `capture()` itself is fire-and-forget and
 * returns before the network POST lands; awaiting `client.flush()` lets the stdio server (and any
 * short-lived CLI path) hold the process open until the event is sent or definitively failed.
 *
 * Client lifetime: constructs a fresh PostHog client per call (same as the remote wrapper) rather than
 * reusing one across the process. That keeps each call's flush/shutdown self-contained and avoids
 * holding an idle long-lived client in a long-running `--stdio` session; the flush-before-return
 * guarantee does not depend on process-exit hooks.
 */
export async function recordMcpToolCall(options: RecordMcpToolCallOptions, event: McpToolCallEvent): Promise<void> {
  // Opt-in default OFF (#6236, per #6228's privacy decision) -- unlike the remote wrapper, presence of an
  // API key alone is not enough; the user must have explicitly enabled telemetry.
  if (options?.telemetryEnabled !== true) return;

  const apiKey = trimmedOrUndefined(process.env.LOOPOVER_MCP_POSTHOG_API_KEY);
  // Unconfigured -> record nothing, byte-identical to before this module existed.
  if (!apiKey) return;

  const host = trimmedOrUndefined(process.env.LOOPOVER_MCP_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST;
  try {
    const client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 0 });
    client.capture({
      distinctId: MCP_TELEMETRY_DISTINCT_ID,
      event: MCP_TOOL_CALL_EVENT,
      // Exactly the #6228 allowlist -- nothing more.
      properties: {
        tool: event.tool,
        caller_type: event.callerType ?? "local",
        ok: event.ok,
        duration_ms: event.durationMs,
      },
      // No IP-based geo enrichment: the event is anonymous fleet telemetry, not a user location.
      disableGeoip: true,
    });
    await client.flush();
  } catch {
    // Telemetry is best-effort and MUST NOT throw into the CLI (#6236): a PostHog init/capture/flush
    // failure degrades to recording nothing, identical to the unconfigured path above.
  }
}

/**
 * Stdio-tool chokepoint (#6238 / #8690): every registerStdioTool-registered tool routes through here
 * once per invocation. Awaits {@link recordMcpToolCall}'s flush, and never lets a telemetry failure
 * reach the tool caller (defensive try/catch on top of recordMcpToolCall's own never-throw guarantee).
 */
export async function recordStdioToolTelemetry(
  telemetryEnabled: boolean,
  tool: string,
  ok: boolean,
  durationMs: number,
  record: (options: RecordMcpToolCallOptions, event: McpToolCallEvent) => Promise<void> = recordMcpToolCall,
): Promise<void> {
  try {
    await record({ telemetryEnabled }, { tool, callerType: "local", ok, durationMs });
  } catch {
    // Telemetry must never affect the tool response (#6238).
  }
}

type StdioToolHandler = (...args: any[]) => Promise<any>;

/**
 * Wrap a stdio tool handler so success and throw paths both await telemetry flush before returning
 * (#8690). Lives in lib/ (not bin/) so codecov/patch can attribute the await branches via unit tests;
 * bin registration stays thin glue.
 */
export function wrapStdioToolHandler(
  name: string,
  getTelemetryEnabled: () => boolean,
  handler: StdioToolHandler,
): StdioToolHandler {
  return async (...args) => {
    const startedAt = Date.now();
    try {
      const result = await handler(...args);
      // Mirror the remote's caller-visible outcome (`response.status < 400`): a handler that reports
      // failure by returning an error result is not a success, even though it never threw.
      await recordStdioToolTelemetry(getTelemetryEnabled(), name, result?.isError !== true, Date.now() - startedAt);
      return result;
    } catch (error) {
      await recordStdioToolTelemetry(getTelemetryEnabled(), name, false, Date.now() - startedAt);
      throw error;
    }
  };
}

/** Trim a possibly-undefined env string, treating blank/whitespace as absent. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
