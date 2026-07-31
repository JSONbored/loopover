import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => {
  const captureException = vi.fn();
  const capture = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  let lastArgs: any;
  const PostHog = vi.fn(function (this: any, apiKey: string, options: any) {
    lastArgs = { apiKey, options };
    this.captureException = captureException;
    this.capture = capture;
    this.flush = flush;
  });
  return { captureException, capture, flush, PostHog, getLastArgs: () => lastArgs };
});

vi.mock("posthog-node", () => ({ PostHog: posthogMock.PostHog }));

import {
  captureMinerPostHogAiGeneration,
  captureMinerPostHogEvent,
  captureMinerPostHogError,
  captureMinerPostHogErrorAndFlush,
  flushMinerPostHog,
  initMinerPostHog,
  resetMinerPostHogForTesting,
} from "../../packages/loopover-miner/lib/posthog";

beforeEach(() => {
  vi.clearAllMocks();
  posthogMock.flush.mockResolvedValue(undefined);
});

afterEach(() => {
  resetMinerPostHogForTesting();
});

describe("loopover-miner opt-in PostHog (#8292, epic #8286)", () => {
  describe("off state (no API key)", () => {
    it("stays fully off when LOOPOVER_MINER_POSTHOG_API_KEY is unset", async () => {
      expect(await initMinerPostHog({})).toBe(false);
      expect(posthogMock.PostHog).not.toHaveBeenCalled();
      expect(() => captureMinerPostHogError(new Error("x"))).not.toThrow();
      expect(posthogMock.captureException).not.toHaveBeenCalled();
      await expect(flushMinerPostHog()).resolves.toBeUndefined();
      expect(posthogMock.flush).not.toHaveBeenCalled();
    });

    it("REGRESSION: an empty-string API key is treated the same as unset (never activates)", async () => {
      expect(await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "" })).toBe(false);
      expect(posthogMock.PostHog).not.toHaveBeenCalled();
    });

    it("captureMinerPostHogError never throws even when called before initMinerPostHog (default off state)", () => {
      expect(() => captureMinerPostHogError("a plain string, not an Error")).not.toThrow();
      expect(() => captureMinerPostHogError(new Error("boom"), { kind: "test" })).not.toThrow();
    });

    it("defaults to process.env when no env argument is passed", async () => {
      const original = process.env.LOOPOVER_MINER_POSTHOG_API_KEY;
      delete process.env.LOOPOVER_MINER_POSTHOG_API_KEY;
      try {
        expect(await initMinerPostHog()).toBe(false);
      } finally {
        if (original === undefined) delete process.env.LOOPOVER_MINER_POSTHOG_API_KEY;
        else process.env.LOOPOVER_MINER_POSTHOG_API_KEY = original;
      }
    });
  });

  describe("activated state (API key set)", () => {
    it("initializes posthog-node with the key, default host, and short-lived-process flush semantics", async () => {
      expect(await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" })).toBe(true);
      expect(posthogMock.PostHog).toHaveBeenCalledWith("phc_test_key", {
        host: "https://us.i.posthog.com",
        flushAt: 1,
        flushInterval: 0,
      });
    });

    it("uses LOOPOVER_MINER_POSTHOG_HOST when set", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key", LOOPOVER_MINER_POSTHOG_HOST: "https://eu.i.posthog.com" });
      expect(posthogMock.getLastArgs().options.host).toBe("https://eu.i.posthog.com");
    });

    it("captureMinerPostHogError wraps a non-Error value and forwards it via captureException", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogError("plain string reason");
      expect(posthogMock.captureException).toHaveBeenCalledTimes(1);
      const captured = posthogMock.captureException.mock.calls[0]?.[0] as Error;
      expect(captured).toBeInstanceOf(Error);
      expect(captured.message).toBe("plain string reason");
    });

    it("captureMinerPostHogError forwards a real Error instance as-is (not re-wrapped)", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      const original = new Error("real error");
      captureMinerPostHogError(original);
      expect(posthogMock.captureException.mock.calls[0]?.[0]).toBe(original);
    });

    it("passes context as properties only when context is provided (both sides of the branch)", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogError(new Error("with context"), { kind: "test_kind", repoFullName: "acme/widgets" });
      expect(posthogMock.captureException).toHaveBeenCalledWith(expect.any(Error), "loopover-miner", { kind: "test_kind", repoFullName: "acme/widgets" });

      captureMinerPostHogError(new Error("no context"));
      expect(posthogMock.captureException).toHaveBeenLastCalledWith(expect.any(Error), "loopover-miner", undefined);
    });

    it("redacts a secret-shaped context key's VALUE, leaving its sibling keys untouched", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogError(new Error("boom"), { kind: "test", apiKey: "sk-should-not-leak", repoFullName: "acme/widgets" });
      const properties = posthogMock.captureException.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(properties.apiKey).toBe("[redacted]");
      expect(properties.kind).toBe("test");
      expect(properties.repoFullName).toBe("acme/widgets");
    });

    it("REGRESSION: captureMinerPostHogError never throws even when the client itself throws", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      posthogMock.captureException.mockImplementationOnce(() => {
        throw new Error("posthog sdk internal failure");
      });
      expect(() => captureMinerPostHogError(new Error("boom"))).not.toThrow();
    });

    it("flushMinerPostHog calls the client's flush", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      await flushMinerPostHog();
      expect(posthogMock.flush).toHaveBeenCalledTimes(1);
    });

    it("REGRESSION: flushMinerPostHog never throws or rejects even when flush itself rejects", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      posthogMock.flush.mockRejectedValueOnce(new Error("flush timed out"));
      await expect(flushMinerPostHog()).resolves.toBeUndefined();
    });
  });

  it("resetMinerPostHogForTesting returns an activated instance to the default-off no-op", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    resetMinerPostHogForTesting();
    captureMinerPostHogError(new Error("after reset"));
    expect(posthogMock.captureException).not.toHaveBeenCalled();
    await flushMinerPostHog();
    expect(posthogMock.flush).not.toHaveBeenCalled();
  });

  describe("captureMinerPostHogAiGeneration (#8296 AMS follow-up)", () => {
    const BASE = { provider: "claude-cli", model: "claude-sonnet-5", latencyMs: 2500, isError: false };

    it("is a no-op when PostHog is unconfigured", () => {
      expect(() => captureMinerPostHogAiGeneration(BASE)).not.toThrow();
      expect(posthogMock.capture).not.toHaveBeenCalled();
    });

    it("captures a well-formed $ai_generation event, keeping the blended tokens_used alongside the real split", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, totalCostUsd: 0.05 });
      expect(posthogMock.capture).toHaveBeenCalledTimes(1);
      const call = posthogMock.capture.mock.calls[0]?.[0];
      expect(call.event).toBe("$ai_generation");
      expect(call.distinctId).toBe("loopover-miner");
      expect(call.properties.$ai_model).toBe("claude-sonnet-5");
      expect(call.properties.$ai_provider).toBe("claude-cli");
      expect(call.properties.$ai_latency).toBe(2.5);
      expect(call.properties.$ai_http_status).toBe(200);
      // #10198: these are the properties PostHog's own cost views read. They were hardcoded to 0, so the
      // miner's whole spend was invisible there while the real figure sat in the non-standard tokens_used.
      expect(call.properties.$ai_input_tokens).toBe(1200);
      expect(call.properties.$ai_output_tokens).toBe(300);
      expect(call.properties.tokens_used).toBe(1500);
      expect(call.properties.$ai_total_cost_usd).toBe(0.05);
      expect(call.properties.$ai_is_error).toBe(false);
      expect("$ai_input" in call.properties).toBe(false);
      expect("$ai_output_choices" in call.properties).toBe(false);
    });

    it("falls back to 0 for a side the driver could not report, without losing the blended total (#10198)", async () => {
      // A provider that reports only a blended total genuinely has no split; 0 here means "no split known",
      // and tokens_used still carries the figure that IS known.
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, totalTokens: 999 });
      captureMinerPostHogAiGeneration({ ...BASE, totalTokens: 999, inputTokens: 800, outputTokens: Number.NaN });
      const blended = posthogMock.capture.mock.calls[0]?.[0].properties;
      expect(blended.$ai_input_tokens).toBe(0);
      expect(blended.$ai_output_tokens).toBe(0);
      expect(blended.tokens_used).toBe(999);
      const partial = posthogMock.capture.mock.calls[1]?.[0].properties;
      expect(partial.$ai_input_tokens).toBe(800);
      expect(partial.$ai_output_tokens).toBe(0);
    });

    it("omits tokens_used/$ai_total_cost_usd when neither is supplied or finite", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, totalTokens: Number.NaN });
      const { properties } = posthogMock.capture.mock.calls[0]?.[0];
      expect("tokens_used" in properties).toBe(false);
      expect("$ai_total_cost_usd" in properties).toBe(false);
    });

    it("falls back to 'unknown' for a blank model/provider", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, model: "", provider: "   " });
      const { properties } = posthogMock.capture.mock.calls[0]?.[0];
      expect(properties.$ai_model).toBe("unknown");
      expect(properties.$ai_provider).toBe("unknown");
    });

    it("marks a failed generation with $ai_is_error/$ai_http_status/$ai_error, redacted to 500 chars", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, isError: true, error: new Error("x".repeat(600)) });
      const { properties } = posthogMock.capture.mock.calls[0]?.[0];
      expect(properties.$ai_is_error).toBe(true);
      expect(properties.$ai_http_status).toBe(500);
      expect(properties.$ai_error).toHaveLength(500);
    });

    it("wraps a non-Error thrown value on the error path", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration({ ...BASE, isError: true, error: "just a string" });
      expect(posthogMock.capture.mock.calls[0]?.[0].properties.$ai_error).toBe("just a string");
    });

    it("REGRESSION: never throws even when the client itself throws", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      posthogMock.capture.mockImplementationOnce(() => {
        throw new Error("posthog sdk internal failure");
      });
      expect(() => captureMinerPostHogAiGeneration(BASE)).not.toThrow();
    });

    it("mints a fresh, real UUID trace id on every call", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      captureMinerPostHogAiGeneration(BASE);
      captureMinerPostHogAiGeneration(BASE);
      const first = posthogMock.capture.mock.calls[0]?.[0].properties.$ai_trace_id;
      const second = posthogMock.capture.mock.calls[1]?.[0].properties.$ai_trace_id;
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(first).not.toBe(second);
    });
  });

  describe("captureMinerPostHogErrorAndFlush (the crash-path convenience wrapper)", () => {
    it("REGRESSION: captures AND flushes, so a crash-path caller can await it before exiting instead of a bare capture that only queues the event", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      const error = new Error("crash");
      await captureMinerPostHogErrorAndFlush(error, { kind: "uncaughtException" });
      expect(posthogMock.captureException).toHaveBeenCalledWith(error, "loopover-miner", { kind: "uncaughtException" });
      expect(posthogMock.flush).toHaveBeenCalledTimes(1);
    });

    it("resolves cleanly (no throw) when PostHog is off", async () => {
      await expect(captureMinerPostHogErrorAndFlush(new Error("x"))).resolves.toBeUndefined();
      expect(posthogMock.captureException).not.toHaveBeenCalled();
      expect(posthogMock.flush).not.toHaveBeenCalled();
    });

    it("still resolves cleanly when the underlying flush rejects", async () => {
      await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
      posthogMock.flush.mockRejectedValueOnce(new Error("flush timed out"));
      await expect(captureMinerPostHogErrorAndFlush(new Error("crash"))).resolves.toBeUndefined();
    });
  });
});

// #9525: the thin send the MCP dispatch chokepoint composes its events for. The properties come
// from @loopover/contract so all three servers emit one shape; what is asserted here is this
// function's own contract -- gated, scrubbed, and never throwing.
describe("captureMinerPostHogEvent (#9525)", () => {
  it("sends nothing when PostHog was never initialized", () => {
    captureMinerPostHogEvent("usage_event", { tool: "loopover_miner_ping" });
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("sends the event anonymously, with geoip disabled, once initialized", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    captureMinerPostHogEvent("usage_event", { tool: "loopover_miner_ping", ok: true });
    expect(posthogMock.capture).toHaveBeenCalledOnce();
    expect(posthogMock.capture.mock.calls[0]![0]).toMatchObject({
      distinctId: "loopover-miner",
      event: "usage_event",
      properties: { tool: "loopover_miner_ping", ok: true },
      disableGeoip: true,
    });
  });

  it("scrubs a secret-shaped property key on the way out", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    captureMinerPostHogEvent("usage_event", { tool: "t", githubToken: "ghp_realtokenvaluehere" });
    expect(posthogMock.capture.mock.calls[0]![0].properties.githubToken).toBe("[redacted]");
  });

  it("never throws when the SDK's capture does", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    posthogMock.capture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    expect(() => captureMinerPostHogEvent("usage_event", { tool: "t" })).not.toThrow();
  });
});
