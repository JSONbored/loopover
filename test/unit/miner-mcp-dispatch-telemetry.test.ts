// The miner MCP server's dispatch-telemetry chokepoint (#9525).
//
// Its sink is this package's own opt-in PostHog client, so both sides of that gate are driven here
// via the module's exported reset helper rather than by mocking the SDK.
import { afterEach, describe, expect, it } from "vitest";
import { resolveErrorCode } from "@loopover/contract";
import { recordMinerDispatchTelemetry } from "../../packages/loopover-miner/lib/mcp-dispatch-telemetry";
import { resetMinerPostHogForTesting } from "../../packages/loopover-miner/lib/posthog";

afterEach(() => {
  resetMinerPostHogForTesting();
});

describe("miner dispatch telemetry (#9525)", () => {
  it("is a silent no-op when the miner's PostHog client is not initialized", () => {
    expect(() =>
      recordMinerDispatchTelemetry({ tool: "loopover_miner_ping", ok: true, durationMs: 3, args: {}, result: { status: "ok" } }),
    ).not.toThrow();
  });

  it("never throws on the failure path, with or without an error value", () => {
    expect(() => recordMinerDispatchTelemetry({ tool: "loopover_miner_ping", ok: false, durationMs: 3, error: new Error("boom") })).not.toThrow();
    // `error` absent on a failed call: the exception-capture arm must be skipped, not passed undefined.
    expect(() => recordMinerDispatchTelemetry({ tool: "loopover_miner_ping", ok: false, durationMs: 3 })).not.toThrow();
  });

  // #9659: the envelope the tool returned to its caller classifies the failure. The raw error used to be
  // passed instead, so `resolveErrorCode`'s message regexes re-derived a code -- and an ENOENT from a store
  // that would not open matches /not found|no such/, so the caller was told `store_unavailable` while the
  // event recorded `not_found`. Two classifications of one failure, produced by adjacent lines.
  it("classifies by the envelope's declared code, not by re-reading the error's message", () => {
    const enoent = new Error("ENOENT: no such file or directory, open 'queue.db'");
    expect(resolveErrorCode(enoent), "the message alone reads as not_found").toBe("not_found");
    expect(resolveErrorCode({ code: "store_unavailable", message: enoent.message })).toBe("store_unavailable");
  });

  it("still classifies from the raw error when no envelope is supplied", () => {
    expect(resolveErrorCode(new Error("request timed out"))).toBe("timeout");
  });

  it("tolerates a tool with no contract entry rather than throwing on the path it instruments", () => {
    // The contract validator (#9520) makes this unreachable in practice; telemetry still must not be
    // the thing that breaks a tool call if it ever happens.
    expect(() => recordMinerDispatchTelemetry({ tool: "loopover_not_in_the_registry", ok: true, durationMs: 1, args: { a: 1 } })).not.toThrow();
  });
});
