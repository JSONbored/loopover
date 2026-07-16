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

// @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
const { recordMcpToolCall } = await import("../../packages/loopover-mcp/lib/telemetry.js");

// The local wrapper always records a "local" caller (#6236); an opted-in, configured settings object.
const OPTED_IN = { enabled: true, apiKey: "phc_test" };
const EVENT = { tool: "predict_gate", callerType: "local", ok: true, durationMs: 42 };

describe("recordMcpToolCall (local, opt-in)", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
  });

  it("is a safe no-op by default (opt-in flag absent) even when an api key is configured", () => {
    recordMcpToolCall({ apiKey: "phc_test" }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when telemetry is explicitly disabled", () => {
    recordMcpToolCall({ enabled: false, apiKey: "phc_test" }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("treats any non-true enabled value (truthy but not literally true) as opted out", () => {
    // Only a literal `true` counts as enabled, mirroring how the persisted flag is normalized (#6239).
    recordMcpToolCall({ enabled: 1 as unknown as boolean, apiKey: "phc_test" }, EVENT);
    recordMcpToolCall({ enabled: "true" as unknown as boolean, apiKey: "phc_test" }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when settings is missing entirely", () => {
    recordMcpToolCall(undefined as unknown as { enabled?: boolean }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when opted in but no api key is configured (enabled ≠ configured)", () => {
    recordMcpToolCall({ enabled: true }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace api key as unconfigured", () => {
    recordMcpToolCall({ enabled: true, apiKey: "   " }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("captures exactly the allowlisted fields against the US-cloud default host once opted in", () => {
    recordMcpToolCall(OPTED_IN, EVENT);

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
      caller_type: "local",
      ok: true,
      duration_ms: 42,
    });
    // The allowlist is the whole payload — no argument/source/wallet/hotkey/trust-score field can ride along.
    expect(Object.keys(message.properties).sort()).toEqual(["caller_type", "duration_ms", "ok", "tool"]);
  });

  it("honors a host override and carries a failed call verbatim", () => {
    recordMcpToolCall(
      { enabled: true, apiKey: "phc_test", host: "https://eu.i.posthog.com" },
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

  it("trims surrounding whitespace from the api key and host", () => {
    recordMcpToolCall({ enabled: true, apiKey: "  phc_test  ", host: "  https://eu.i.posthog.com  " }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("falls back to the default host when the host is blank", () => {
    recordMcpToolCall({ enabled: true, apiKey: "phc_test", host: "   " }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("never throws when the PostHog client fails to initialize", () => {
    h.state.throwOnConstruct = true;
    expect(() => recordMcpToolCall(OPTED_IN, EVENT)).not.toThrow();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("never throws when capture itself fails", () => {
    h.state.throwOnCapture = true;
    expect(() => recordMcpToolCall(OPTED_IN, EVENT)).not.toThrow();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
  });
});
