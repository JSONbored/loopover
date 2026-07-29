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
    expect(excluded.arguments).toBeUndefined();
    expect(excluded.result).toBeUndefined();
  });

  it("includes redacted payloads for a tool that permits them", () => {
    const included = buildMcpToolCallProperties(call, { arguments: { owner: "acme" }, result: undefined, excluded: false });
    expect(included.payloads_excluded).toBe(false);
    expect(included.arguments).toBe('{"owner":"acme"}');
    expect(included.result).toBeUndefined();
  });

  it("includes a result with no arguments, and omits each independently", () => {
    const resultOnly = buildMcpToolCallProperties(call, { arguments: undefined, result: { n: 1 }, excluded: false });
    expect(resultOnly.arguments).toBeUndefined();
    expect(resultOnly.result).toBe('{"n":1}');
    const neither = buildMcpToolCallProperties(call, { excluded: false });
    expect("arguments" in neither).toBe(false);
    expect("result" in neither).toBe(false);
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
    const allowed = new Set<string>(MCP_TELEMETRY_PROPERTY_KEYS);
    const failing: McpToolCallTelemetry = { ...call, ok: false, errorCode: "timeout" };
    const payloads = [
      buildUsageEventProperties(call),
      buildUsageEventProperties(failing),
      buildMcpToolCallProperties(call, { arguments: { a: 1 }, result: { b: 2 }, excluded: false }),
      buildMcpToolCallProperties(failing, { arguments: { a: 1 }, excluded: true }),
      buildMcpToolSpanAttributes(failing),
    ];
    for (const payload of payloads) {
      for (const key of Object.keys(payload)) expect(allowed, `${key} is not allowlisted`).toContain(key);
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
    expect(calls[0]).toMatchObject({ ok: false, errorCode: "unknown_error" });
    expect(exceptions).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mcp_tool_call_failed"));
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
