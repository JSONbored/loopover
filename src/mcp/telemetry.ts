import { PostHog } from "posthog-node";

// MCP telemetry wrapper (#6235, foundation of #6228). A thin, typed seam around the PostHog Node SDK so the
// rest of this MCP-telemetry work has ONE place to record a tool call — no other module ever constructs a raw
// PostHog event. The tracked-field allowlist decided in #6228 (tool name + caller type + success + coarse
// latency, and NOTHING else — no arguments, no source, no wallet/hotkey/trust-score data) is enforced here at
// the type level: the only way in is {@link recordMcpToolCall}, whose event shape is exactly the allowlist.
//
// SAFE NO-OP WHEN UNCONFIGURED: telemetry is opt-in. A deployment that never sets POSTHOG_API_KEY — every
// self-hoster who doesn't opt in — records nothing and behaves byte-identically to before this module existed.
// The wrapper also never throws: a PostHog init/capture failure degrades to recording nothing, exactly like
// the unconfigured path, so it can never surface an error into the MCP tool caller.
//
// NOT WIRED YET: per #6235 this module is deliberately NOT called from the tool-dispatch path — that (and the
// client lifecycle/flush strategy a live Worker needs) is the separate instrumentation issue's job.

/** PostHog US-cloud ingestion host — the default when POSTHOG_HOST isn't set. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The PostHog event name every MCP tool call is recorded under. */
const MCP_TOOL_CALL_EVENT = "mcp_tool_call";

/** Anonymous, constant distinct id: the fleet telemetry carries NO per-actor identity by design (#6228), so
 *  every event shares one handle and there is no per-user person to build up. */
const MCP_TELEMETRY_DISTINCT_ID = "loopover-mcp";

/** Which MCP surface a recorded tool call came through: the remote MCP (src/mcp/server.ts) is `"remote"`, the
 *  local stdio MCP (@loopover/mcp) is `"local"`. This is the caller-type dimension #6228 tracks. */
export type McpTelemetryCallerType = "remote" | "local";

/** The COMPLETE, allowlisted shape of an MCP tool-call telemetry event (#6228). These four fields are the only
 *  thing ever sent to PostHog; the type is the enforcement — a caller cannot smuggle in an argument, a repo, or
 *  any wallet/hotkey/trust-score field, because there is nowhere in this shape to put it. */
export interface McpToolCallEvent {
  /** The MCP tool name, e.g. `"predict_gate"`. */
  tool: string;
  /** Which MCP surface dispatched the call. */
  callerType: McpTelemetryCallerType;
  /** Whether the tool call succeeded. */
  ok: boolean;
  /** Coarse wall-clock duration of the call, in milliseconds. */
  durationMs: number;
}

/** The env slice this wrapper reads. Both vars are opt-in secrets declared in `src/env.d.ts`; a live Worker
 *  passes its own `Env`, which is structurally assignable here. */
export type McpTelemetryEnv = Pick<Env, "POSTHOG_API_KEY" | "POSTHOG_HOST">;

/** Record a single MCP tool call to PostHog. Safe no-op when telemetry is unconfigured (no POSTHOG_API_KEY),
 *  and never throws — a PostHog init/capture failure degrades to recording nothing (#6235). */
export function recordMcpToolCall(env: McpTelemetryEnv, event: McpToolCallEvent): void {
  const apiKey = trimmedOrUndefined(env.POSTHOG_API_KEY);
  // Unconfigured ⇒ record nothing, byte-identical to before this module existed.
  if (!apiKey) return;

  const host = trimmedOrUndefined(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST;
  try {
    const client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 0 });
    client.capture({
      distinctId: MCP_TELEMETRY_DISTINCT_ID,
      event: MCP_TOOL_CALL_EVENT,
      // Exactly the #6228 allowlist — nothing more.
      properties: {
        tool: event.tool,
        caller_type: event.callerType,
        ok: event.ok,
        duration_ms: event.durationMs,
      },
      // No IP-based geo enrichment: the event is anonymous fleet telemetry, not a user location.
      disableGeoip: true,
    });
  } catch {
    // Telemetry is best-effort and MUST NOT throw into the MCP tool caller (#6235): a PostHog init/capture
    // failure degrades to recording nothing, identical to the unconfigured path above.
  }
}

/** Trim a possibly-undefined env string, treating blank/whitespace as absent. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
