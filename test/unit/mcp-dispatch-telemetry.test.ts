// Telemetry-shape guarantees for the MCP dispatch chokepoint (#9525).
//
// The two that matter most are the last two: no telemetry payload may carry a key outside the
// single-sourced allowlist, and no secret-shaped value from a tool's own input or output may reach
// a sink. Both are asserted rather than assumed, because the failure mode is silent -- data leaves
// the box and nothing at the wire tells you.
import { describe, expect, it, vi } from "vitest";
import {
  buildMcpToolCallProperties,
  buildMcpToolSpanAttributes,
  buildUsageEventProperties,
  capturePayload,
  MCP_TELEMETRY_ERROR_CODES,
  MCP_TELEMETRY_PAYLOAD_BYTE_CAP,
  MCP_TELEMETRY_PROPERTY_KEYS,
  MCP_CANONICAL_PROPERTY_KEYS,
  MCP_ANALYTICS_SOURCE,
  buildMcpInitializeProperties,
  buildMcpToolsListProperties,
  mcpErrorType,
  mcpToolSpanName,
  REDACTED,
  redactForTelemetry,
  resolveErrorCode,
  toolExcludesPayloads,
  TOOL_CONTRACTS,
  type McpToolCallTelemetry,
} from "@loopover/contract";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content";
import { instrumentToolDispatch, NOOP_DISPATCH_SINK, type DispatchTelemetrySink } from "../../src/mcp/dispatch-telemetry";

const call: McpToolCallTelemetry = { tool: "loopover_get_repo_context", category: "maintainer", surface: "remote", ok: true, durationMs: 12 };

describe("MCP telemetry event shapes (#9525)", () => {
  it("omits error_code on success rather than sending it as null", () => {
    const properties = buildUsageEventProperties(call);
    expect(properties).toEqual({ tool: call.tool, category: "maintainer", surface: "remote", transport: "local", ok: true, duration_ms: 12 });
    expect("error_code" in properties).toBe(false);
  });

  it("defaults transport to local for a sink with no notion of proxying, and reports it when there is one (#9526)", () => {
    // Always emitted, never conditional: a breakdown by transport with an empty `local` bucket would read
    // as "nothing runs locally" rather than "most sinks do not set this".
    expect(buildUsageEventProperties(call).transport).toBe("local");
    expect(buildUsageEventProperties({ ...call, surface: "stdio", transport: "proxied" }).transport).toBe("proxied");
  });

  it("carries the closed error code on failure", () => {
    expect(buildUsageEventProperties({ ...call, ok: false, errorCode: "not_found" })).toMatchObject({ ok: false, error_code: "not_found" });
  });

  it("marks a payload-excluded tool explicitly rather than silently omitting", () => {
    const excluded = buildMcpToolCallProperties(call, { arguments: { a: 1 }, result: { b: 2 }, excluded: true });
    expect(excluded.payloads_excluded).toBe(true);
    expect(excluded.$mcp_parameters).toBeUndefined();
    expect(excluded.$mcp_response).toBeUndefined();
  });

  it("includes redacted payloads for a tool that permits them", () => {
    const included = buildMcpToolCallProperties(call, { arguments: { owner: "acme" }, result: undefined, excluded: false });
    expect(included.payloads_excluded).toBe(false);
    expect(included.$mcp_parameters).toBe('{"owner":"acme"}');
    expect(included.$mcp_response).toBeUndefined();
  });

  it("includes a result with no arguments, and omits each independently", () => {
    const resultOnly = buildMcpToolCallProperties(call, { arguments: undefined, result: { n: 1 }, excluded: false });
    expect(resultOnly.$mcp_parameters).toBeUndefined();
    expect(resultOnly.$mcp_response).toBe('{"n":1}');
    const neither = buildMcpToolCallProperties(call, { excluded: false });
    expect("$mcp_parameters" in neither).toBe(false);
    expect("$mcp_response" in neither).toBe(false);
  });

  it("omits error_code from span attributes on a successful call", () => {
    expect("error_code" in buildMcpToolSpanAttributes(call)).toBe(false);
  });

  it("keeps span attributes a strict subset -- never arguments or the excluded marker", () => {
    const attributes = buildMcpToolSpanAttributes({ ...call, ok: false, errorCode: "timeout" });
    expect(Object.keys(attributes).sort()).toEqual(["category", "duration_ms", "error_code", "ok", "surface", "tool", "transport"]);
    expect(mcpToolSpanName("loopover_x")).toBe("mcp.tool/loopover_x");
  });
});

describe("MCP telemetry redaction (#9525)", () => {
  it("drops a secret-shaped key entirely -- name and value -- at every depth", () => {
    expect(redactForTelemetry({ token: "abc", nested: { apiKey: "x", githubToken: "y", safe: 1 } })).toEqual({
      nested: { safe: 1 },
    });
  });

  it("drops secret-shaped values regardless of their key", () => {
    expect(redactForTelemetry({ note: "ghp_aaaaaaaaaaaaaaaaaaaa" })).toEqual({ note: REDACTED });
    expect(redactForTelemetry(["sk-aaaaaaaaaaaaaaaaaaaa", "fine"])).toEqual([REDACTED, "fine"]);
  });

  it("stops recursing past a sane depth rather than following a deep structure forever", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 12; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactForTelemetry(deep))).toContain(REDACTED);
  });

  it("passes scalars through untouched", () => {
    expect(redactForTelemetry(7)).toBe(7);
    expect(redactForTelemetry(null)).toBeNull();
    expect(redactForTelemetry(undefined)).toBeUndefined();
  });

  it("returns undefined when the redacted payload serializes to nothing at all", () => {
    // Everything dropped by the key filter leaves an empty object, which is not worth an event.
    expect(capturePayload(undefined)).toBeUndefined();
  });

  it("caps an oversized payload and returns undefined for nothing to send", () => {
    expect(capturePayload(undefined)).toBeUndefined();
    const big = capturePayload({ note: "x".repeat(MCP_TELEMETRY_PAYLOAD_BYTE_CAP * 2) });
    expect(big!.endsWith("…[truncated]")).toBe(true);
    expect(big!.length).toBeLessThan(MCP_TELEMETRY_PAYLOAD_BYTE_CAP + 32);
  });

  it("severs a circular payload at the depth cap instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(capturePayload(circular)).toContain(REDACTED);
  });

  it("returns undefined rather than throwing on a genuinely unserializable payload", () => {
    expect(capturePayload({ big: BigInt(1) })).toBeUndefined();
  });

  it("returns undefined for a value JSON.stringify simply declines to represent", () => {
    // Not an error, just nothing: stringify answers `undefined` for a bare function or symbol
    // rather than throwing, so the nullish arm and the empty-string check are a separate path from
    // the catch above.
    expect(capturePayload(() => undefined)).toBeUndefined();
    expect(capturePayload(Symbol("s"))).toBeUndefined();
  });
});

describe("MCP telemetry error codes (#9525)", () => {
  it("prefers a declared envelope code", () => {
    expect(resolveErrorCode({ code: "rate_limited" })).toBe("rate_limited");
    expect(resolveErrorCode({ code: "something_invented" })).toBe("unknown_error");
  });

  it("maps the messages the servers actually produce, and nothing else", () => {
    expect(resolveErrorCode(new Error("Invalid input: expected number"))).toBe("invalid_input");
    expect(resolveErrorCode(new Error("unauthorized"))).toBe("unauthorized");
    expect(resolveErrorCode(new Error("access denied"))).toBe("forbidden");
    expect(resolveErrorCode(new Error("No such pull request"))).toBe("not_found");
    expect(resolveErrorCode(new Error("not configured"))).toBe("not_configured");
    expect(resolveErrorCode(new Error("rate limit exceeded"))).toBe("rate_limited");
    expect(resolveErrorCode(new Error("request timed out"))).toBe("timeout");
    expect(resolveErrorCode(new Error("declined"))).toBe("elicitation_declined");
    expect(resolveErrorCode(new Error("upstream 503"))).toBe("upstream_error");
    expect(resolveErrorCode(new Error("something nobody anticipated"))).toBe("unknown_error");
    expect(resolveErrorCode("a bare string")).toBe("unknown_error");
    expect(resolveErrorCode(undefined)).toBe("unknown_error");
  });
});

describe("MCP telemetry allowlist (#9525)", () => {
  it("emits no property key outside the single-sourced allowlist", () => {
    // TWO vocabularies, deliberately (#10175): LoopOver's snake_case keys on `usage_event` and the
    // OTel span, PostHog's reserved `$mcp_*` keys on the canonical events. `$mcp_tool_call` draws
    // from BOTH -- the canonical keys their dashboards read, plus the three LoopOver dimensions with
    // no canonical equivalent -- so it is checked against the union. Nothing may emit a key outside.
    const native = new Set<string>(MCP_TELEMETRY_PROPERTY_KEYS);
    const canonical = new Set<string>(MCP_CANONICAL_PROPERTY_KEYS);
    const union = new Set<string>([...native, ...canonical]);
    const failing: McpToolCallTelemetry = { ...call, ok: false, errorCode: "timeout" };
    const ctx = { sessionId: "ses_abc", serverName: "loopover", serverVersion: "3.18.4", clientName: "claude-code", clientVersion: "1.2.3" };

    for (const payload of [buildUsageEventProperties(call), buildUsageEventProperties(failing), buildMcpToolSpanAttributes(failing)]) {
      for (const key of Object.keys(payload)) expect(native, `${key} is not allowlisted`).toContain(key);
    }
    for (const payload of [
      buildMcpToolCallProperties(call, { arguments: { a: 1 }, result: { b: 2 }, excluded: false }, ctx),
      buildMcpToolCallProperties(failing, { arguments: { a: 1 }, excluded: true }),
    ]) {
      for (const key of Object.keys(payload)) expect(union, `${key} is not allowlisted`).toContain(key);
    }
    for (const payload of [
      buildMcpInitializeProperties({ clientName: "claude-code", clientVersion: "1.2.3" }, ctx),
      buildMcpInitializeProperties({}),
      buildMcpToolsListProperties(["loopover_get_repo_context"], ctx),
      buildMcpToolsListProperties([]),
    ]) {
      for (const key of Object.keys(payload)) expect(canonical, `${key} is not allowlisted`).toContain(key);
    }
  });

  it("excludes payloads for EVERY tool in the registry, not just the operator-facing ones", () => {
    // The default is exclude, for all 125. Most of these tools take the user's own content as their
    // input -- lint_pr_text takes the PR body, check_slop_risk takes the commit messages -- and none
    // of that is secret-SHAPED, so a redaction pass would have shipped it verbatim. The
    // subprocess-level chokepoint test found exactly that on the wire when the default was the
    // other way round.
    const included = TOOL_CONTRACTS.filter((contract) => !toolExcludesPayloads(contract)).map((contract) => contract.name);
    expect(included, "a tool opted into payload telemetry -- that needs an argued reason, not a default").toEqual([]);
    // And the operator surfaces are excluded a second, independent way, so populating the opt-in
    // allowlist can never accidentally qualify one.
    for (const contract of TOOL_CONTRACTS) {
      if (contract.category === "admin" || contract.auth === "mcp-admin") {
        expect(toolExcludesPayloads({ ...contract, name: "pretend-this-is-allowlisted" }), `${contract.name} must never send payloads`).toBe(true);
      }
    }
  });

  it("lets no secret-shaped value reach a sink from a tool's own arguments or result", () => {
    // The FORBIDDEN_CONTENT pattern the package-publish checks use, pointed at telemetry instead.
    const hostile = {
      githubToken: "ghp_aaaaaaaaaaaaaaaaaaaa",
      nested: { coldkey: "5FHneW46...", posthogKey: "phc_aaaaaaaaaaaaaaaaaaaa" },
      body: "-----BEGIN RSA PRIVATE KEY-----abc",
    };
    const properties = buildMcpToolCallProperties(call, { arguments: hostile, result: hostile, excluded: false });
    const serialized = JSON.stringify(properties);
    expect(FORBIDDEN_CONTENT.test(serialized)).toBe(false);
    // Neither the values nor the key names survive.
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("coldkey");
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("keeps the closed error-code set closed", () => {
    expect(new Set(MCP_TELEMETRY_ERROR_CODES).size).toBe(MCP_TELEMETRY_ERROR_CODES.length);
    expect(MCP_TELEMETRY_ERROR_CODES).toContain("unknown_error");
  });
});

describe("MCP dispatch chokepoint (#9525)", () => {
  const sink = (): { sink: DispatchTelemetrySink; calls: McpToolCallTelemetry[]; exceptions: unknown[] } => {
    const calls: McpToolCallTelemetry[] = [];
    const exceptions: unknown[] = [];
    return {
      calls,
      exceptions,
      sink: {
        recordToolCall: (recorded) => calls.push(recorded),
        captureException: (error) => exceptions.push(error),
        withSpan: async (_name, _attributes, fn) => fn(),
      },
    };
  };

  it("records a success", async () => {
    const { sink: spy, calls } = sink();
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", spy, async (_args: unknown) => ({ structuredContent: { ok: 1 } }));
    await wrapped({ owner: "a", repo: "b" });
    expect(calls[0]).toMatchObject({ tool: "loopover_get_repo_context", category: "maintainer", surface: "remote", ok: true });
    expect(calls[0]!.errorCode).toBeUndefined();
  });

  it("treats an error envelope as a failed call, not an exception", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sink: spy, calls, exceptions } = sink();
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", spy, async (_args: unknown) => ({ isError: true, structuredContent: {} }));
    await wrapped({});
    // No envelope on the result: `unknown_error` is the honest answer, and stays the answer (#9659).
    expect(calls[0]).toMatchObject({ ok: false, errorCode: "unknown_error" });
    expect(exceptions).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mcp_tool_call_failed"));
    warn.mockRestore();
  });

  // #9659: the code the caller is told is the code the event records. Before this the remote emitted a
  // hardcoded `"unknown_error"` for every returned failure, so the dimension the closed set exists to
  // populate was dead on the only failure path that does not throw.
  it("resolves the error code from the result's own envelope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sink: spy, calls } = sink();
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", spy, async (_args: unknown) => ({
      isError: true,
      structuredContent: { error: { code: "not_configured", message: "no token" } },
    }));
    await wrapped({});
    expect(calls[0]).toMatchObject({ ok: false, errorCode: "not_configured" });
    warn.mockRestore();
  });

  it("falls back to unknown_error for an envelope whose code is not in the closed set", async () => {
    // A tool cannot widen the dimension by inventing a code: `resolveErrorCode` validates membership.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sink: spy, calls } = sink();
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", spy, async (_args: unknown) => ({
      isError: true,
      structuredContent: { error: { code: "made_up", message: "nope" } },
    }));
    await wrapped({});
    expect(calls[0]).toMatchObject({ ok: false, errorCode: "unknown_error" });
    warn.mockRestore();
  });

  it("captures a genuine throw, rethrows it, and logs at error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sink: spy, calls, exceptions } = sink();
    const boom = new Error("not configured");
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", spy, async (_args: unknown) => {
      throw boom;
    });
    await expect(wrapped({})).rejects.toThrow("not configured");
    expect(calls[0]).toMatchObject({ ok: false, errorCode: "not_configured" });
    expect(exceptions).toEqual([boom]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("mcp_tool_call_threw"));
    error.mockRestore();
  });

  it("never lets a sink failure reach the caller, on either path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hostile: DispatchTelemetrySink = {
      recordToolCall: () => {
        throw new Error("sink down");
      },
      captureException: () => {
        throw new Error("sink down");
      },
      withSpan: async (_name, _attributes, fn) => fn(),
    };
    const ok = instrumentToolDispatch("loopover_get_repo_context", hostile, async (_args: unknown) => ({ structuredContent: { fine: true } }));
    await expect(ok({})).resolves.toMatchObject({ structuredContent: { fine: true } });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throws = instrumentToolDispatch("loopover_get_repo_context", hostile, async (_args: unknown) => {
      throw new Error("original");
    });
    // The ORIGINAL error, not the sink's -- telemetry must not replace the failure it observed.
    await expect(throws({})).rejects.toThrow("original");
    warn.mockRestore();
    error.mockRestore();
  });

  it("passes through unchanged with the no-op sink, whose every slot is inert", async () => {
    const wrapped = instrumentToolDispatch("loopover_get_repo_context", NOOP_DISPATCH_SINK, async (_args: unknown) => ({ structuredContent: { v: 1 } }));
    await expect(wrapped({})).resolves.toMatchObject({ structuredContent: { v: 1 } });
    // Called directly too: the no-op sink is what a deployment with nothing configured runs on
    // every single call, so "does nothing and returns nothing" is worth asserting outright.
    expect(NOOP_DISPATCH_SINK.recordToolCall(call, { usage: {}, mcpToolCall: {} })).toBeUndefined();
    expect(NOOP_DISPATCH_SINK.captureException(new Error("x"), call)).toBeUndefined();
    await expect(NOOP_DISPATCH_SINK.withSpan("n", {}, async () => "through")).resolves.toBe("through");
  });

  it("falls back to the unknown category for a tool with no contract entry", async () => {
    const { sink: spy, calls } = sink();
    const wrapped = instrumentToolDispatch("loopover_not_in_the_registry", spy, async (_args: unknown) => ({ structuredContent: {} }));
    await wrapped({});
    expect(calls[0]).toMatchObject({ category: "unknown" });
  });
});

describe("PostHog canonical MCP analytics contract (#10175)", () => {
  const ctx = { sessionId: "ses_abc123", serverName: "loopover", serverVersion: "3.18.4", clientName: "claude-code", clientVersion: "1.2.3" };

  it("emits $mcp_tool_call under PostHog's own property names, not LoopOver's", () => {
    // The whole point of this event: PostHog's built-in MCP dashboards read these exact `$mcp_*`
    // keys literally. Emitting the event NAME with LoopOver-native keys ingests fine and leaves
    // every breakdown empty -- which is precisely the bug #10175 fixes.
    const properties = buildMcpToolCallProperties(call, { excluded: true }, ctx);
    expect(properties.$mcp_source).toBe(MCP_ANALYTICS_SOURCE);
    expect(properties.$mcp_tool_name).toBe("loopover_get_repo_context");
    expect(properties.$mcp_duration_ms).toBe(12);
    expect(properties.$mcp_is_error).toBe(false);
    expect(properties.$session_id).toBe("ses_abc123");
    expect(properties.$mcp_server_name).toBe("loopover");
    expect(properties.$mcp_server_version).toBe("3.18.4");
    expect(properties.$mcp_client_name).toBe("claude-code");
    expect(properties.$mcp_client_version).toBe("1.2.3");
    // LoopOver's own dimensions ride alongside rather than replacing the canonical ones.
    expect(properties.surface).toBe("remote");
    expect(properties.transport).toBe("local");
    expect(properties.category).toBe("maintainer");
  });

  it("omits $mcp_error_type on success and sets it on failure", () => {
    expect("$mcp_error_type" in buildMcpToolCallProperties(call, { excluded: true })).toBe(false);
    const failed = buildMcpToolCallProperties({ ...call, ok: false, errorCode: "rate_limited" }, { excluded: true });
    expect(failed.$mcp_is_error).toBe(true);
    expect(failed.$mcp_error_type).toBe("rate_limited");
  });

  it("projects every LoopOver error code onto a member of PostHog's closed $mcp_error_type set", () => {
    // PostHog groups failures by this fixed set; a code mapping outside it would silently fall out
    // of their error breakdown entirely.
    const posthogTypes = new Set(["missing_context", "validation", "permission", "timeout", "rate_limited", "api_4xx", "api_5xx", "internal"]);
    for (const code of MCP_TELEMETRY_ERROR_CODES) {
      expect(posthogTypes, `${code} maps outside PostHog's set`).toContain(mcpErrorType(code));
    }
    // No code at all is still a failure by construction at every call site, and PostHog's set has no
    // "unclassified" member, so it buckets as the fault type.
    expect(mcpErrorType(undefined)).toBe("internal");
  });

  it("defaults the context to an empty one, still stamping $mcp_source", () => {
    const properties = buildMcpToolCallProperties(call, { excluded: true });
    expect(properties.$mcp_source).toBe(MCP_ANALYTICS_SOURCE);
    for (const key of ["$session_id", "$mcp_server_name", "$mcp_server_version", "$mcp_client_name", "$mcp_client_version"]) {
      expect(key in properties, `${key} should be omitted, not null`).toBe(false);
    }
  });

  it("omits blank and whitespace-only context values rather than emitting empty dimensions", () => {
    const properties = buildMcpToolCallProperties(call, { excluded: true }, { sessionId: "   ", serverName: "", clientName: "cursor" });
    expect("$session_id" in properties).toBe(false);
    expect("$mcp_server_name" in properties).toBe(false);
    expect(properties.$mcp_client_name).toBe("cursor");
  });

  it("truncates an over-long client-supplied label so it cannot blow up a dashboard dimension", () => {
    const properties = buildMcpToolCallProperties(call, { excluded: true }, { clientName: "x".repeat(500) });
    expect(properties.$mcp_client_name).toBe("x".repeat(256));
  });

  it("prefers the handshake's own clientInfo over anything inferred from headers", () => {
    // clientInfo is the MCP spec's own field, sent by the client about itself; the header-derived
    // value is a LoopOver convention only our own published client sets.
    const properties = buildMcpInitializeProperties({ clientName: "cursor", clientVersion: "9.9.9" }, { ...ctx });
    expect(properties.$mcp_client_name).toBe("cursor");
    expect(properties.$mcp_client_version).toBe("9.9.9");
    expect(properties.$mcp_server_name).toBe("loopover");
  });

  it("falls back to the inferred client when the handshake omits clientInfo", () => {
    const properties = buildMcpInitializeProperties({}, ctx);
    expect(properties.$mcp_client_name).toBe("claude-code");
    expect(properties.$mcp_client_version).toBe("1.2.3");
  });

  it("still emits a handshake with no client identity at all", () => {
    // A client that omits clientInfo completes a valid handshake -- a session that connected is
    // still worth counting, in an explicit "unknown client" bucket.
    expect(buildMcpInitializeProperties({})).toEqual({ $mcp_source: MCP_ANALYTICS_SOURCE });
  });

  it("lists advertised tool names for the discovery join", () => {
    const properties = buildMcpToolsListProperties(["a_tool", "b_tool"], ctx);
    expect(properties.$mcp_listed_tool_names).toEqual(["a_tool", "b_tool"]);
    expect(properties.$session_id).toBe("ses_abc123");
  });

  it("copies the tool-name array rather than aliasing the caller's own", () => {
    // The server hands in its live registration array; a captured alias would let a later
    // registration mutate an event already queued for flush.
    const names = ["a_tool"];
    const properties = buildMcpToolsListProperties(names);
    names.push("b_tool");
    expect(properties.$mcp_listed_tool_names).toEqual(["a_tool"]);
  });

  it("emits an empty advertised list rather than omitting the property", () => {
    // A server advertising nothing is a real, diagnosable state; an absent key reads as "not
    // measured" instead.
    expect(buildMcpToolsListProperties([]).$mcp_listed_tool_names).toEqual([]);
  });
});
