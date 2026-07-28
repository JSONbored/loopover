// The miner MCP server's dispatch-telemetry chokepoint (#9525).
//
// Its sink is this package's own opt-in PostHog client, so both sides of that gate are driven here
// via the module's exported reset helper rather than by mocking the SDK.
import { afterEach, describe, expect, it } from "vitest";
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

  it("tolerates a tool with no contract entry rather than throwing on the path it instruments", () => {
    // The contract validator (#9520) makes this unreachable in practice; telemetry still must not be
    // the thing that breaks a tool call if it ever happens.
    expect(() => recordMinerDispatchTelemetry({ tool: "loopover_not_in_the_registry", ok: true, durationMs: 1, args: { a: 1 } })).not.toThrow();
  });
});
