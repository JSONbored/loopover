import { describe, expect, it, vi } from "vitest";
import {
  GATE_VERDICTS,
  mapGateDisposition,
  readGateDisposition,
  pollGateVerdict,
} from "../../packages/gittensory-miner/lib/gate-verdict-poller.js";

const URL = "https://api.gittensory.test/v1/contributors/dhgoal/open-pr-monitor";
const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("gittensory-miner gate-verdict poller (#4273)", () => {
  it("exposes the frozen verdict vocabulary", () => {
    expect(GATE_VERDICTS).toEqual(["merge", "close", "hold", "pending"]);
    expect(Object.isFrozen(GATE_VERDICTS)).toBe(true);
  });

  it("maps each disposition family (with synonyms, case-insensitive) to a verdict", () => {
    expect(mapGateDisposition("merged")).toBe("merge");
    expect(mapGateDisposition("Approved")).toBe("merge");
    expect(mapGateDisposition("closed")).toBe("close");
    expect(mapGateDisposition("REJECTED")).toBe("close");
    expect(mapGateDisposition(" action_required ")).toBe("hold");
    expect(mapGateDisposition("flagged")).toBe("hold");
  });

  it("maps unknown/missing/non-string dispositions to pending, never a false decided verdict", () => {
    expect(mapGateDisposition("open")).toBe("pending");
    expect(mapGateDisposition("")).toBe("pending");
    expect(mapGateDisposition(undefined)).toBe("pending");
    expect(mapGateDisposition(42)).toBe("pending");
  });

  it("reads the disposition from any of the tolerated field names, else null", () => {
    expect(readGateDisposition({ disposition: "merge" })).toBe("merge");
    expect(readGateDisposition({ gateDisposition: "hold" })).toBe("hold");
    expect(readGateDisposition({ verdict: "closed" })).toBe("closed");
    expect(readGateDisposition({ other: "x" })).toBeNull();
    expect(readGateDisposition({ disposition: 7 })).toBeNull(); // non-string
    expect(readGateDisposition(null)).toBeNull();
  });

  it("throws on a missing URL", async () => {
    await expect(pollGateVerdict("")).rejects.toThrow(/invalid_gate_verdict_url/);
  });

  it("returns a decided verdict on the first attempt without sleeping", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ disposition: "merge" }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await pollGateVerdict(URL, { fetchFn, sleepFn });
    expect(result).toMatchObject({ verdict: "merge", disposition: "merge", attempts: 1 });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("backs off while pending, then returns the decided verdict", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ disposition: "pending" }))
      .mockResolvedValueOnce(okResponse({ disposition: "pending" }))
      .mockResolvedValueOnce(okResponse({ disposition: "close" }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await pollGateVerdict(URL, { fetchFn, sleepFn, minIntervalMs: 100, maxIntervalMs: 1000 });
    expect(result.verdict).toBe("close");
    expect(result.attempts).toBe(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 100); // 100 * 2^0
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200); // 100 * 2^1
  });

  it("stops at maxAttempts and returns the last pending verdict when never decided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ disposition: "pending" }));
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const result = await pollGateVerdict(URL, { fetchFn, sleepFn, maxAttempts: 3 });
    expect(result.verdict).toBe("pending");
    expect(result.attempts).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2); // no sleep after the final attempt
  });

  it("throws on a non-OK HTTP response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(pollGateVerdict(URL, { fetchFn, sleepFn: vi.fn() })).rejects.toThrow(/gate_verdict_http_503/);
  });
});
