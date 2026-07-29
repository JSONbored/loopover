// The miner MCP server's dispatch-telemetry chokepoint (#9525).
//
// Same shape as the other two servers -- every property, the closed error-code set, and the
// redaction all come from @loopover/contract -- but it rides THIS package's own opt-in PostHog
// client (lib/posthog.ts, #8292), because the miner is a separately published CLI an operator
// points at their OWN project and nothing here is ever auto-enabled.
//
// Fire-and-forget rather than awaited: unlike the stdio CLI, this server is long-lived, so there is
// no imminent process exit to flush before, and blocking a tool response on a telemetry POST would
// be a real latency cost for no benefit. lib/posthog.ts's flushAt:1 sends immediately anyway.
import {
  buildMcpToolCallProperties,
  buildUsageEventProperties,
  getToolContract,
  MCP_TOOL_CALL_EVENT,
  MCP_USAGE_EVENT,
  resolveErrorCode,
  toolExcludesPayloads,
  UNKNOWN_TOOL_CATEGORY,
  type McpToolCallTelemetry,
} from "@loopover/contract";
import { captureMinerPostHogError, captureMinerPostHogEvent } from "./posthog.js";

export type MinerDispatchCall = {
  tool: string;
  ok: boolean;
  durationMs: number;
  args?: unknown;
  result?: unknown;
  /** The raw thrown value, kept for the exception capture -- an envelope has no stack. */
  error?: unknown;
  /** The envelope the tool returned to its caller (#9659). Preferred for classification, so the code the
   *  caller was told and the code recorded here are the same one rather than two guesses at one failure. */
  errorEnvelope?: { code: string; message: string };
};

/** Emit both usage events, plus an exception capture on the failure path. Never throws. */
export function recordMinerDispatchTelemetry(call: MinerDispatchCall): void {
  try {
    const contract = getToolContract(call.tool);
    const telemetry: McpToolCallTelemetry = {
      tool: call.tool,
      category: contract?.category ?? UNKNOWN_TOOL_CATEGORY,
      surface: "miner",
      ok: call.ok,
      durationMs: call.durationMs,
      ...(call.ok ? {} : { errorCode: resolveErrorCode(call.errorEnvelope ?? call.error) }),
    };
    captureMinerPostHogEvent(MCP_USAGE_EVENT, buildUsageEventProperties(telemetry));
    captureMinerPostHogEvent(
      MCP_TOOL_CALL_EVENT,
      buildMcpToolCallProperties(telemetry, {
        arguments: call.args,
        result: call.result,
        // No contract entry means no way to know whether the payload is safe, so it is withheld.
        excluded: contract ? toolExcludesPayloads(contract) : true,
      }),
    );
    if (!call.ok && call.error !== undefined) {
      captureMinerPostHogError(call.error, { mcp_tool: telemetry.tool, error_code: telemetry.errorCode });
    }
  } catch {
    // Telemetry must never surface into a tool response.
  }
}
