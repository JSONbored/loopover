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

/**
 * PostHog's own MCP-Analytics handshake event, the sibling of MCP_TOOL_CALL_EVENT.
 *
 * Emitted once per `initialize` -- the first message of every MCP session -- and it is what lets
 * PostHog's built-in MCP dashboards break usage down by CLIENT (Claude Code vs Cursor vs a raw SDK
 * script) and by client version. `$mcp_tool_call` cannot answer that: it carries what was called,
 * never who connected.
 */
export const MCP_INITIALIZE_EVENT = "$mcp_initialize";

/**
 * PostHog's own tools/list event.
 *
 * Measures DISCOVERY, which no other event can: joined against `$mcp_tool_call` on `$session_id`, it
 * separates a tool nobody wants from a tool nobody could find.
 */
export const MCP_TOOLS_LIST_EVENT = "$mcp_tools_list";

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
  // #9659: the miner's own envelope has always returned this to callers -- a local SQLite store that
  // will not open. It belongs in the closed set so ONE code can serve both the envelope and the
  // telemetry event, rather than the event re-deriving a different one from the message.
  "store_unavailable",
  "unknown_error",
] as const;
export type McpTelemetryErrorCode = (typeof MCP_TELEMETRY_ERROR_CODES)[number];

/** Which server answered. The one dimension that is not derivable from the registry. */
export const MCP_TELEMETRY_SURFACES = ["remote", "stdio", "miner"] as const;
export type McpTelemetrySurface = (typeof MCP_TELEMETRY_SURFACES)[number];

/**
 * HOW the answering server executed the call (#9526).
 *
 * Orthogonal to `surface`, which says which server was asked. Since the stdio gateway mounts the remote
 * tool set, one `surface: "stdio"` call may have run against the local checkout or been forwarded to the
 * hosted server, and those are different products from an adoption standpoint: gateway uptake is exactly
 * the count of `stdio` + `proxied`, and it is unmeasurable without this dimension because the tool name
 * alone does not say which path a given release took.
 */
export const MCP_TELEMETRY_TRANSPORTS = ["local", "proxied"] as const;
export type McpTelemetryTransport = (typeof MCP_TELEMETRY_TRANSPORTS)[number];

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
  "transport",
  "ok",
  "duration_ms",
  "error_code",
  "arguments",
  "result",
  "payloads_excluded",
] as const;
export type McpTelemetryPropertyKey = (typeof MCP_TELEMETRY_PROPERTY_KEYS)[number];

/**
 * The allowlist for the canonical `$mcp_*` events, kept SEPARATE from the list above.
 *
 * These are `$`-prefixed because they are PostHog's OWN reserved MCP-Analytics property names, not
 * LoopOver's. Their built-in MCP dashboards read `$mcp_tool_name` / `$mcp_duration_ms` /
 * `$mcp_is_error` literally, so renaming them into this file's snake_case house style produces an
 * event that ingests cleanly and populates nothing -- which is exactly what `$mcp_tool_call` did
 * before #10175. Two lists rather than one union, so a native key can never quietly satisfy the
 * canonical check (or the reverse).
 */
export const MCP_CANONICAL_PROPERTY_KEYS = [
  "$mcp_source",
  "$session_id",
  "$mcp_server_name",
  "$mcp_server_version",
  "$mcp_client_name",
  "$mcp_client_version",
  "$mcp_tool_name",
  "$mcp_duration_ms",
  "$mcp_is_error",
  "$mcp_error_type",
  "$mcp_parameters",
  "$mcp_response",
  "$mcp_listed_tool_names",
] as const;
export type McpCanonicalPropertyKey = (typeof MCP_CANONICAL_PROPERTY_KEYS)[number];

/**
 * The literal `$mcp_source` value PostHog's own MCP-Analytics SDK stamps on every event it emits.
 *
 * Hardcoded to PostHog's constant rather than something LoopOver-specific: it is what their own
 * dashboards filter on to separate MCP traffic from everything else in a mixed project, so a "more
 * accurate" custom value here would simply make this server invisible to them.
 */
export const MCP_ANALYTICS_SOURCE = "posthog_mcp_analytics";

/**
 * Session/server/client identity stamped onto every canonical `$mcp_*` event.
 *
 * `$session_id` is what ties a handshake, a tools/list, and the tool calls that followed into one
 * analyzable session -- without it each event is an isolated row and no funnel across them works.
 *
 * `| undefined` is explicit on every field rather than just `?`: this package compiles under
 * `exactOptionalPropertyTypes`, where an optional property may be ABSENT but not present-and-
 * undefined. Callers build this by reading headers and request params that are routinely missing,
 * so `{ sessionId: maybeUndefined }` is the normal shape and must typecheck without every call site
 * spreading conditionally.
 */
export type McpAnalyticsContext = {
  sessionId?: string | undefined;
  serverName?: string | undefined;
  serverVersion?: string | undefined;
  clientName?: string | undefined;
  clientVersion?: string | undefined;
};

/** Cap on the free-form, client-supplied strings that become dashboard dimensions, so a hostile or
 *  buggy client cannot push an unbounded (or unbounded-cardinality) value into a breakdown. */
const MCP_LABEL_MAX_CHARS = 256;

function mcpLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MCP_LABEL_MAX_CHARS ? trimmed.slice(0, MCP_LABEL_MAX_CHARS) : trimmed;
}

/** Absent fields are OMITTED rather than sent as null, matching buildUsageEventProperties' own
 *  reasoning: a breakdown should not grow a phantom bucket for what was never reported. */
export function buildMcpContextProperties(context: McpAnalyticsContext): Record<string, unknown> {
  const sessionId = mcpLabel(context.sessionId);
  const serverName = mcpLabel(context.serverName);
  const serverVersion = mcpLabel(context.serverVersion);
  const clientName = mcpLabel(context.clientName);
  const clientVersion = mcpLabel(context.clientVersion);
  return {
    $mcp_source: MCP_ANALYTICS_SOURCE,
    ...(sessionId === undefined ? {} : { $session_id: sessionId }),
    ...(serverName === undefined ? {} : { $mcp_server_name: serverName }),
    ...(serverVersion === undefined ? {} : { $mcp_server_version: serverVersion }),
    ...(clientName === undefined ? {} : { $mcp_client_name: clientName }),
    ...(clientVersion === undefined ? {} : { $mcp_client_version: clientVersion }),
  };
}

/**
 * LoopOver's closed error-code set, projected onto PostHog's own `$mcp_error_type` categories.
 *
 * Two vocabularies exist because both are fixed by someone else: MCP_TELEMETRY_ERROR_CODES is what
 * this repo's tool envelopes actually return, and `$mcp_error_type` is the closed set PostHog's MCP
 * dashboards group by. A projection is the only way to serve both without one going empty --
 * `usage_event` keeps the precise LoopOver code, this keeps the coarse PostHog category.
 */
const MCP_ERROR_TYPE_BY_CODE: Record<McpTelemetryErrorCode, string> = {
  invalid_input: "validation",
  unauthorized: "permission",
  forbidden: "permission",
  // A 404 here is a client asking for something absent -- PostHog's own bucket for an upstream 4xx,
  // not an internal fault of ours.
  not_found: "api_4xx",
  // The OPERATOR has not supplied something the tool needs, which is what PostHog means by
  // missing_context -- as opposed to a caller sending bad input, which is `validation`.
  not_configured: "missing_context",
  rate_limited: "rate_limited",
  upstream_error: "api_5xx",
  timeout: "timeout",
  // The human declined an elicitation, so the call is missing something it needed to proceed.
  elicitation_declined: "missing_context",
  store_unavailable: "internal",
  unknown_error: "internal",
};

/** `internal` for an absent code: `$mcp_is_error` is true by construction wherever this is called,
 *  and PostHog's set has no "unclassified" member, so the fault bucket is the safe default. */
export function mcpErrorType(errorCode: McpTelemetryErrorCode | undefined): string {
  return errorCode === undefined ? "internal" : MCP_ERROR_TYPE_BY_CODE[errorCode];
}

/**
 * What a server observes about one `initialize` handshake.
 *
 * Both fields are optional because they are: `clientInfo` is optional in the MCP spec's own
 * initialize params, and a client that omits it still completes a valid handshake. The event is
 * still worth emitting then -- a session that connected is a session that connected, and an
 * explicit "unknown client" bucket is a real signal about who is calling.
 */
export const McpInitializeTelemetry = z.object({
  clientName: z.string().min(1).optional(),
  clientVersion: z.string().min(1).optional(),
});
export type McpInitializeTelemetry = z.infer<typeof McpInitializeTelemetry>;

/** The handshake event's properties. The handshake's own `clientInfo` wins over anything the caller
 *  inferred from headers: it is the MCP spec's own field, sent by the client about itself. */
export function buildMcpInitializeProperties(
  handshake: McpInitializeTelemetry,
  context: McpAnalyticsContext = {},
): Record<string, unknown> {
  return buildMcpContextProperties({
    ...context,
    clientName: handshake.clientName ?? context.clientName,
    clientVersion: handshake.clientVersion ?? context.clientVersion,
  });
}

/** What a dispatch chokepoint observes about one call. */
export const McpToolCallTelemetry = z.object({
  tool: z.string().min(1),
  category: z.string().min(1),
  surface: z.enum(MCP_TELEMETRY_SURFACES),
  // Optional at the seam, never optional on the wire: a sink that has no notion of proxying (the Worker
  // and the miner both execute everything themselves) should not have to say so, but a breakdown by
  // transport still needs both buckets populated, so buildUsageEventProperties defaults it.
  transport: z.enum(MCP_TELEMETRY_TRANSPORTS).optional(),
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
    transport: call.transport ?? "local",
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
  context: McpAnalyticsContext = {},
): Record<string, unknown> {
  const args = payloads.excluded ? undefined : capturePayload(payloads.arguments);
  const result = payloads.excluded ? undefined : capturePayload(payloads.result);
  return {
    ...buildMcpContextProperties(context),
    $mcp_tool_name: call.tool,
    $mcp_duration_ms: call.durationMs,
    $mcp_is_error: !call.ok,
    ...(call.ok ? {} : { $mcp_error_type: mcpErrorType(call.errorCode) }),
    ...(args === undefined ? {} : { $mcp_parameters: args }),
    ...(result === undefined ? {} : { $mcp_response: result }),
    // LoopOver's own dimensions, carried ALONGSIDE the canonical keys rather than instead of them.
    // PostHog's custom-server docs sanction this explicitly ("any extra props, spread verbatim,
    // sitting alongside the $mcp_* keys"), and these three have no canonical equivalent: `surface`
    // says which of the three servers answered, `transport` whether the stdio gateway proxied it,
    // and `category` groups the ~125 tools. Without them on THIS event a breakdown of canonical
    // tool calls by those dimensions is impossible -- `usage_event` carries them, but it is a
    // different event, so the two cannot be combined in one breakdown.
    surface: call.surface,
    transport: call.transport ?? "local",
    category: call.category,
    payloads_excluded: payloads.excluded,
  };
}

/**
 * `$mcp_tools_list` -- what the server advertised in a `tools/list` response.
 *
 * Names only, never descriptions or schemas. The array is COPIED because callers hand in their live
 * registration array; a captured alias would let a later registration mutate an event already
 * queued for flush.
 */
export function buildMcpToolsListProperties(
  toolNames: readonly string[],
  context: McpAnalyticsContext = {},
): Record<string, unknown> {
  return { ...buildMcpContextProperties(context), $mcp_listed_tool_names: [...toolNames] };
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
    transport: call.transport ?? "local",
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
/**
 * The error envelope a tool's `structuredContent` carries, if it carries one (#9659).
 *
 * Every server reports failure the same way -- `isError: true` plus `{ error: { code, message } }` -- but
 * each was reading that result differently, or not at all: the remote emitted a hardcoded
 * `"unknown_error"`, the stdio one passed nothing to the classifier, and the miner passed the raw thrown
 * error so the code was re-derived from message regexes and disagreed with the code the caller was given.
 * Feed the result of this straight to `resolveErrorCode`, which validates the declared code against the
 * closed set and falls back for anything else.
 */
export function toolErrorEnvelope(structuredContent: unknown): { code?: unknown; message?: unknown } | undefined {
  if (typeof structuredContent !== "object" || structuredContent === null) return undefined;
  const envelope = (structuredContent as { error?: unknown }).error;
  return typeof envelope === "object" && envelope !== null ? (envelope as { code?: unknown; message?: unknown }) : undefined;
}

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
