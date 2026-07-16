import { PostHog } from "posthog-node";

// Local MCP telemetry wrapper (#6236, part of #6228). The local-side counterpart of the remote server's
// wrapper (src/mcp/telemetry.ts, #6235): a thin, typed seam around the PostHog Node SDK so the local
// tool-dispatch instrumentation has ONE place to record a tool call. The tracked-field allowlist from #6228
// (tool name + caller type + success + coarse latency, and NOTHING else — no arguments, no source, no
// wallet/hotkey/trust-score data) is the entire `event` shape below; there is nowhere to smuggle anything else.
//
// OPT-IN, DEFAULT OFF: unlike the hosted remote server (opt-out), the local `--stdio` CLI runs on a user's own
// machine, a materially different trust posture (#6228). So this wrapper gates on an explicit opt-in flag BEFORE
// anything else — `settings.enabled` must be literally `true` (the persisted `telemetryEnabled` flag surfaced by
// `telemetryState`, set via `loopover-mcp telemetry enable`, #6239). Until a user opts in, this records nothing.
//
// SAFE NO-OP / NEVER THROWS: when telemetry is disabled, unconfigured (no api key), or the PostHog init/capture
// fails, this records nothing and behaves byte-identically to before the module existed — a telemetry failure can
// never surface an error into, or otherwise affect, the CLI's actual command behavior (#6236).
//
// NOT WIRED YET: per #6236 this module is deliberately NOT called from the tool-dispatch path — wiring the local
// chokepoint to call it is the separate instrumentation issue's job (#6238).

/** PostHog US-cloud ingestion host — the default when no host is supplied. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The PostHog event name every MCP tool call is recorded under (shared with the remote wrapper). */
const MCP_TOOL_CALL_EVENT = "mcp_tool_call";

/** Anonymous, constant distinct id: the fleet telemetry carries NO per-actor identity by design (#6228), so
 *  every event shares one handle and there is no per-user person to build up. */
const MCP_TELEMETRY_DISTINCT_ID = "loopover-mcp";

/**
 * @typedef {Object} McpTelemetrySettings
 * @property {boolean} [enabled] The persisted opt-in flag (`telemetryState().enabled`). Must be literally
 *   `true` to send anything — anything else (the default) keeps telemetry off.
 * @property {string} [apiKey] The PostHog project api key (from `POSTHOG_API_KEY`). Absent/blank ⇒ unconfigured.
 * @property {string} [host] The PostHog ingestion host (from `POSTHOG_HOST`). Absent/blank ⇒ US-cloud default.
 */

/**
 * The COMPLETE, allowlisted shape of an MCP tool-call telemetry event (#6228). These four fields are the only
 * thing ever sent to PostHog — the shape is the enforcement, mirroring the remote wrapper exactly.
 * @typedef {Object} McpToolCallEvent
 * @property {string} tool The MCP tool name, e.g. `"predict_gate"`.
 * @property {"remote" | "local"} callerType Which MCP surface dispatched the call — always `"local"` here.
 * @property {boolean} ok Whether the tool call succeeded.
 * @property {number} durationMs Coarse wall-clock duration of the call, in milliseconds.
 */

/**
 * Record a single local MCP tool call to PostHog. Safe no-op unless the user has opted in
 * (`settings.enabled === true`) AND a PostHog api key is configured; never throws — a disabled, unconfigured, or
 * failing telemetry path degrades to recording nothing, identical to before this module existed (#6236).
 * @param {McpTelemetrySettings} settings
 * @param {McpToolCallEvent} event
 * @returns {void}
 */
export function recordMcpToolCall(settings, event) {
  // Opt-in gate first: only a literal `true` counts as enabled, so the default (absent/false/any other value)
  // records nothing without ever touching the api key or the network.
  if (settings?.enabled !== true) return;

  const apiKey = trimmedOrUndefined(settings.apiKey);
  // Enabled but unconfigured ⇒ still record nothing, byte-identical to before this module existed.
  if (!apiKey) return;

  const host = trimmedOrUndefined(settings.host) ?? DEFAULT_POSTHOG_HOST;
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
    // Telemetry is best-effort and MUST NOT throw into the CLI (#6236): a PostHog init/capture failure degrades
    // to recording nothing, identical to the disabled/unconfigured paths above.
  }
}

/** Trim a possibly-undefined string, treating blank/whitespace as absent. */
function trimmedOrUndefined(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
