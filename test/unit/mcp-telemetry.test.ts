import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the PostHog Node SDK so nothing hits the network: the class records every constructor + capture call
// on hoisted spies, and per-test flags let us force an init/capture failure to exercise the never-throw path.
const h = vi.hoisted(() => ({
  constructSpy: vi.fn(),
  captureSpy: vi.fn(),
  state: { throwOnConstruct: false, throwOnCapture: false },
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(apiKey: string, options: unknown) {
      h.constructSpy(apiKey, options);
      if (h.state.throwOnConstruct) throw new Error("posthog init failed");
    }
    capture(message: unknown): void {
      h.captureSpy(message);
      if (h.state.throwOnCapture) throw new Error("posthog capture failed");
    }
  },
}));

import { recordMcpToolCall, type McpToolCallEvent } from "../../src/mcp/telemetry";

const EVENT: McpToolCallEvent = { tool: "predict_gate", callerType: "remote", ok: true, durationMs: 42 };

describe("recordMcpToolCall", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
  });

  it("is a safe no-op when POSTHOG_API_KEY is unset (unconfigured deployment)", () => {
    recordMcpToolCall({}, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace API key as unconfigured", () => {
    recordMcpToolCall({ POSTHOG_API_KEY: "   " }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("captures exactly the allowlisted fields against the US-cloud default host when configured", () => {
    recordMcpToolCall({ POSTHOG_API_KEY: "phc_test" }, EVENT);

    expect(h.constructSpy).toHaveBeenCalledTimes(1);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });

    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    const message = h.captureSpy.mock.calls[0]![0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      disableGeoip: boolean;
    };
    expect(message.distinctId).toBe("loopover-mcp");
    expect(message.event).toBe("mcp_tool_call");
    expect(message.disableGeoip).toBe(true);
    expect(message.properties).toEqual({
      tool: "predict_gate",
      caller_type: "remote",
      ok: true,
      duration_ms: 42,
    });
    // The allowlist is the whole payload — no argument/source/wallet/hotkey/trust-score field can ride along.
    expect(Object.keys(message.properties).sort()).toEqual(["caller_type", "duration_ms", "ok", "tool"]);
  });

  it("honors a POSTHOG_HOST override and carries a local caller / failed call verbatim", () => {
    recordMcpToolCall(
      { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" },
      { tool: "check_slop_risk", callerType: "local", ok: false, durationMs: 0 },
    );

    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
    const message = h.captureSpy.mock.calls[0]![0] as { properties: Record<string, unknown> };
    expect(message.properties).toEqual({
      tool: "check_slop_risk",
      caller_type: "local",
      ok: false,
      duration_ms: 0,
    });
  });

  it("trims surrounding whitespace from the API key and host", () => {
    recordMcpToolCall({ POSTHOG_API_KEY: "  phc_test  ", POSTHOG_HOST: "  https://eu.i.posthog.com  " }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("falls back to the default host when POSTHOG_HOST is blank", () => {
    recordMcpToolCall({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "   " }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("never throws when the PostHog client fails to initialize", () => {
    h.state.throwOnConstruct = true;
    expect(() => recordMcpToolCall({ POSTHOG_API_KEY: "phc_test" }, EVENT)).not.toThrow();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("never throws when capture itself fails", () => {
    h.state.throwOnCapture = true;
    expect(() => recordMcpToolCall({ POSTHOG_API_KEY: "phc_test" }, EVENT)).not.toThrow();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
  });
});
