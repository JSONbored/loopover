// MCP dispatch telemetry: the one definition of WHAT is emitted (#9525).
//
// Three servers, one shape. Each runtime keeps its own thin sink -- the Worker and the self-host
// Node process share `posthog-node`, the stdio CLI has its own double-gated client, the miner has
// its own opt-in one -- but none of them decides what a telemetry event contains. That lives here,
// in the zod-only leaf every surface already depends on, which is what makes a single allowlist
// enforceable rather than aspirational. Before this, the three had three property lists.
//
// NOTHING IN THIS FILE PERFORMS I/O. It is pure data and pure functions, so the redaction and the
// size caps are unit-testable without a network, and so this package stays the dependency-free leaf
// that every other one can import.
import { z } from "zod";
import type { ToolCategory, ToolContract } from "./tool-definition.js";

/** PostHog's own MCP-Analytics event family (#7737 upstream). */
export const MCP_TOOL_CALL_EVENT = "$mcp_tool_call";

/** LoopOver's own minimal usage event -- no arguments, no results, ever. */
export const MCP_USAGE_EVENT = "usage_event";

/**
 * Why a call failed, as a CLOSED set.
 *
 * Developer-defined and deliberately small: telemetry breaks failures down by cause, and a
 * caller-derived string in that position would be both a cardinality explosion and an injection of
 * untrusted text into a dashboard. Anything that does not map to one of these is `unknown_error`.
 */
export const MCP_TELEMETRY_ERROR_CODES = [
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "not_configured",
  "rate_limited",
  "upstream_error",
  "timeout",
  "elicitation_declined",
  "unknown_error",
] as const;
export type McpTelemetryErrorCode = (typeof MCP_TELEMETRY_ERROR_CODES)[number];

/** Which server answered. The one dimension that is not derivable from the registry. */
export const MCP_TELEMETRY_SURFACES = ["remote", "stdio", "miner"] as const;
export type McpTelemetrySurface = (typeof MCP_TELEMETRY_SURFACES)[number];

/**
 * The COMPLETE set of property keys any MCP telemetry event may carry.
 *
 * Single-sourced so the meta-test can assert no payload key exists outside it. The check is worth
 * having because the failure it prevents is silent: a property added at one sink ships data the
 * other two never agreed to send, and nothing at the wire tells you.
 */
export const MCP_TELEMETRY_PROPERTY_KEYS = [
  "tool",
  "category",
  "surface",
  "ok",
  "duration_ms",
  "error_code",
  "arguments",
  "result",
  "payloads_excluded",
] as const;
export type McpTelemetryPropertyKey = (typeof MCP_TELEMETRY_PROPERTY_KEYS)[number];

/** What a dispatch chokepoint observes about one call. */
export const McpToolCallTelemetry = z.object({
  tool: z.string().min(1),
  category: z.string().min(1),
  surface: z.enum(MCP_TELEMETRY_SURFACES),
  ok: z.boolean(),
  durationMs: z.number().int().min(0),
  errorCode: z.enum(MCP_TELEMETRY_ERROR_CODES).optional(),
});
export type McpToolCallTelemetry = z.infer<typeof McpToolCallTelemetry>;

/**
 * The minimal usage event: identity-free, payload-free, and the same on all three servers.
 *
 * `error_code` is omitted rather than sent as null on success, so a breakdown by error_code has no
 * phantom bucket.
 */
export function buildUsageEventProperties(call: McpToolCallTelemetry): Record<string, unknown> {
  return {
    tool: call.tool,
    category: call.category,
    surface: call.surface,
    ok: call.ok,
    duration_ms: call.durationMs,
    ...(call.errorCode ? { error_code: call.errorCode } : {}),
  };
}

/**
 * Whether a tool's arguments and results may ride the MCP-Analytics event.
 *
 * DEFAULT: NO, for every tool. That default is not caution for its own sake -- it is the standing
 * guarantee LoopOver's telemetry has always made and that
 * test/unit/mcp-local-telemetry-chokepoint.test.ts has asserted since #6238: the call's actual
 * content never leaves the machine. Most of these tools take the user's own content AS their input.
 * `loopover_lint_pr_text` takes the PR body. `loopover_check_slop_risk` takes the commit messages.
 * `loopover_intake_idea` takes a freeform brief. Including arguments "with redaction" would have
 * shipped all three, since none of them is secret-SHAPED -- it is simply the user's writing.
 *
 * This was not the first design. #9525 initially inverted it: include payloads except for
 * admin/operator tools. The chokepoint test rejected it within one run by finding a real commit
 * message on the wire, which is exactly the kind of promise a test should be enforcing rather than
 * a comment.
 *
 * The mechanism stays because the MCP-Analytics event family is defined to carry these fields, and
 * a future tool whose input is genuinely server-derived metadata can opt in by name here. Nothing
 * does today, and adding one should be an argued change with the tool named in the diff.
 */
const TOOLS_WITH_PAYLOAD_TELEMETRY: ReadonlySet<string> = new Set();

export function toolIncludesPayloads(contract: Pick<ToolContract, "name" | "category" | "auth">): boolean {
  // The operator surfaces are excluded a second way, deliberately: were the allowlist above ever
  // populated, an admin tool must still never qualify.
  if (contract.category === "admin" || contract.auth === "mcp-admin" || contract.auth === "operator") return false;
  return TOOLS_WITH_PAYLOAD_TELEMETRY.has(contract.name);
}

/** The inverse, kept because every call site reads better as "excluded". */
export function toolExcludesPayloads(contract: Pick<ToolContract, "name" | "category" | "auth">): boolean {
  return !toolIncludesPayloads(contract);
}

/** Property keys whose values are dropped wholesale, matched case-insensitively on the KEY. */
const SECRET_KEY_PATTERN = /token|secret|password|passwd|dsn|credential|api[_-]?key|coldkey|hotkey|wallet|cookie|authorization|session/i;

/**
 * Value substrings that mark a string as secret-shaped regardless of its key.
 *
 * The token prefixes carry their own `\b`; the PEM header must NOT, because a word boundary before
 * a leading hyphen never matches and the whole alternative would be dead. That is not hypothetical
 * -- it was, until the forbidden-content test in test/unit/mcp-dispatch-telemetry.test.ts caught a
 * complete RSA PEM private-key header passing through untouched.
 *
 * That header is described rather than quoted on purpose: this file is PUBLISHED (#9749), and a literal
 * key marker in the tarball trips every secret scanner that reads it -- ours in check-contract-package.ts,
 * and a consumer's own. The pattern on the next line is what must be exact; the prose need not be.
 */
const SECRET_VALUE_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|phc_[A-Za-z0-9]{16,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export const REDACTED = "[redacted]";

/** Default byte cap for an included arguments/result payload. Small on purpose: this is a telemetry
 *  breadcrumb, not a copy of the traffic. */
export const MCP_TELEMETRY_PAYLOAD_BYTE_CAP = 2048;

/**
 * Redact a value for telemetry: drop secret-shaped keys and values at every depth, then cap the
 * serialized size.
 *
 * Recursive, unlike the miner's own flat scrubber, because a tool's arguments are arbitrarily
 * nested by construction -- a flat pass over a `plannedChange.contributorLogin` would miss it.
 *
 * A secret-shaped KEY is dropped ENTIRELY, key and value both, rather than kept with a `[redacted]`
 * placeholder. The placeholder form leaves the key NAME in the payload, and a property literally
 * named `coldkey` or `githubToken` is itself something the repo's forbidden-content checks (rightly)
 * treat as a finding -- there is no telemetry question that a key name answers, so nothing is lost
 * by omitting it and a whole class of false-negative review is avoided.
 */
export function redactForTelemetry(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === "string") return SECRET_VALUE_PATTERN.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((entry) => redactForTelemetry(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      result[key] = redactForTelemetry(entry, depth + 1);
    }
    return result;
  }
  return value;
}

/** Redact, serialize, and cap. Returns undefined when there is nothing to send. */
export function capturePayload(value: unknown, byteCap = MCP_TELEMETRY_PAYLOAD_BYTE_CAP): string | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(redactForTelemetry(value)) ?? "";
  } catch {
    // An unserializable payload (a BigInt, say) is not worth a telemetry failure. A CIRCULAR one
    // never reaches here -- the depth cap above severs the cycle first -- which is the point of
    // capping by depth rather than tracking seen references.
    return undefined;
  }
  if (serialized.length === 0) return undefined;
  return serialized.length <= byteCap ? serialized : `${serialized.slice(0, byteCap)}…[truncated]`;
}

/**
 * PostHog's `$mcp_tool_call` event: the usage properties plus, for tools that permit it, redacted
 * and capped arguments/results.
 *
 * When payloads are excluded the event says so explicitly (`payloads_excluded: true`) rather than
 * silently omitting them -- an absent field and a deliberately withheld one are different facts, and
 * only one of them is worth alerting on.
 */
export function buildMcpToolCallProperties(
  call: McpToolCallTelemetry,
  payloads: { arguments?: unknown; result?: unknown; excluded: boolean },
): Record<string, unknown> {
  const base = buildUsageEventProperties(call);
  if (payloads.excluded) return { ...base, payloads_excluded: true };
  const args = capturePayload(payloads.arguments);
  const result = capturePayload(payloads.result);
  return {
    ...base,
    payloads_excluded: false,
    ...(args === undefined ? {} : { arguments: args }),
    ...(result === undefined ? {} : { result }),
  };
}

/**
 * OTel span attributes for one tool call.
 *
 * Deliberately a STRICT SUBSET of the usage event -- no arguments, no results, not even the
 * excluded-marker. A span is exported to a collector an operator may share more widely than their
 * analytics project, so the safe default is that it carries only what a latency dashboard needs.
 */
export function buildMcpToolSpanAttributes(call: McpToolCallTelemetry): Record<string, unknown> {
  return {
    tool: call.tool,
    category: call.category,
    surface: call.surface,
    ok: call.ok,
    duration_ms: call.durationMs,
    ...(call.errorCode ? { error_code: call.errorCode } : {}),
  };
}

/** The span name for a tool call. */
export function mcpToolSpanName(tool: string): string {
  return `mcp.tool/${tool}`;
}

/**
 * Map a thrown error or an error envelope onto the closed code set.
 *
 * Matches on shape and on the small set of messages the servers actually produce; everything else
 * is `unknown_error` rather than a guess. Never reads a caller-supplied string into the code.
 */
export function resolveErrorCode(error: unknown): McpTelemetryErrorCode {
  const envelope = error as { code?: unknown } | null | undefined;
  if (envelope && typeof envelope.code === "string") {
    const declared = MCP_TELEMETRY_ERROR_CODES.find((code) => code === envelope.code);
    if (declared) return declared;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/invalid input|invalid arguments|validation/i.test(message)) return "invalid_input";
  if (/unauthor/i.test(message)) return "unauthorized";
  if (/forbidden|access denied|not permitted/i.test(message)) return "forbidden";
  if (/not found|no such/i.test(message)) return "not_found";
  if (/not configured|unconfigured|missing .*(token|key)/i.test(message)) return "not_configured";
  if (/rate limit|too many requests/i.test(message)) return "rate_limited";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/declined|cancelled by user/i.test(message)) return "elicitation_declined";
  if (/upstream|502|503|504/i.test(message)) return "upstream_error";
  return "unknown_error";
}

/** The category a tool reports when the registry has no entry for it -- which the contract validator
 *  (#9520) makes impossible, but telemetry must never throw on the path it instruments. */
export const UNKNOWN_TOOL_CATEGORY: ToolCategory | "unknown" = "unknown";

/** The LEGACY per-call event both pre-#9525 telemetry modules emit (`mcp_tool_call`, #6228). Kept
 *  alongside the new pair because operators' dashboards read it; see the stdio module's notes. */
export const LEGACY_MCP_TOOL_CALL_EVENT = "mcp_tool_call";

/**
 * The COMPLETE property list of the legacy event (#6228's allowlist), single-sourced (#9521).
 *
 * Until this constant existed the list lived three times -- src/mcp/telemetry.ts,
 * packages/loopover-mcp/lib/telemetry.ts, and the stdio README's prose table -- with nothing
 * holding them together. Both modules now build the event through
 * {@link buildLegacyToolCallProperties}, and the README table is generated from this array.
 */
export const LEGACY_MCP_TELEMETRY_PROPERTY_KEYS = ["tool", "caller_type", "ok", "duration_ms"] as const;

/** The one way to build the legacy event's properties: the shape IS the allowlist, so a caller
 *  cannot smuggle in a fifth field -- there is nowhere in the signature to put it. */
export function buildLegacyToolCallProperties(event: {
  tool: string;
  callerType: "remote" | "local";
  ok: boolean;
  durationMs: number;
}): Record<(typeof LEGACY_MCP_TELEMETRY_PROPERTY_KEYS)[number], string | boolean | number> {
  return { tool: event.tool, caller_type: event.callerType, ok: event.ok, duration_ms: event.durationMs };
}
