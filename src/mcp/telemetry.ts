import { PostHog } from "posthog-node";
import { buildLegacyToolCallProperties } from "@loopover/contract";

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
// WIRED into the remote tool-dispatch path (#6237, merged PR #6358): {@link recordMcpToolCall} is invoked from
// `recordMcpToolTelemetry` in src/mcp/server.ts — the single chokepoint every `tools/call` request that reaches
// handleMcpRequest routes through exactly once, whether it succeeds or throws. (The local/CLI-side counterpart,
// packages/loopover-mcp/lib/telemetry.js, has its own separate wiring status per #6236/#6238.)

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
 *  and never throws — a PostHog init/capture failure degrades to recording nothing (#6235).
 *
 *  Returns a promise that resolves once the event has actually been flushed to PostHog (#7233) — the
 *  `flushAt: 1, flushInterval: 0` config makes `capture()` queue the network request immediately, but
 *  `capture()` itself is fire-and-forget and returns before that request lands. Awaiting `client.flush()`
 *  gives the caller (src/mcp/server.ts's `recordMcpToolTelemetry`, deferred via Cloudflare's `waitUntil`)
 *  real async work to hold the execution context open for, so the event isn't silently dropped if the
 *  Workers runtime tears the request down before an un-awaited background fetch completes. */
export async function recordMcpToolCall(env: McpTelemetryEnv, event: McpToolCallEvent): Promise<void> {
  const apiKey = trimmedOrUndefined(env.POSTHOG_API_KEY);
  // Unconfigured ⇒ record nothing, byte-identical to before this module existed.
  if (!apiKey) return;

  const host = trimmedOrUndefined(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST;
  try {
    const client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 0 });
    client.capture({
      distinctId: MCP_TELEMETRY_DISTINCT_ID,
      event: MCP_TOOL_CALL_EVENT,
      // Exactly the #6228 allowlist — enforced by the shared builder's signature (#9521), so this
      // module can no longer drift from the stdio one or the generated README table.
      properties: buildLegacyToolCallProperties(event),
      // No IP-based geo enrichment: the event is anonymous fleet telemetry, not a user location.
      disableGeoip: true,
    });
    await client.flush();
  } catch {
    // Telemetry is best-effort and MUST NOT throw into the MCP tool caller (#6235): a PostHog init/capture/
    // flush failure degrades to recording nothing, identical to the unconfigured path above.
  }
}

/** Trim a possibly-undefined env string, treating blank/whitespace as absent. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
