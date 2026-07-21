import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGtLogoSvg,
  fetchJson,
  GITTENSOR_IMPACT_CARD_FETCH_TIMEOUT_MS,
} from "../../scripts/gittensor-impact-card.js";

describe("gittensor-impact-card.ts (#7231)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchJson returns the parsed JSON body on a 200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ totalPRs: 5 }),
    });
    await expect(fetchJson("https://api.gittensor.io/repos/x/impact", fetchImpl)).resolves.toEqual({
      totalPRs: 5,
    });
  });

  it("fetchJson throws on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchJson("https://api.gittensor.io/repos/x/impact", fetchImpl)).rejects.toThrow(
      "fetch failed: https://api.gittensor.io/repos/x/impact (500)",
    );
  });

  it("fetchJson bounds its request with the configured AbortSignal.timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchJson("https://api.gittensor.io/repos/x/impact", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchJson aborts instead of hanging when fetchImpl never resolves, using the configured timeout value", async () => {
    // Node's AbortSignal.timeout schedules its own internal, unmockable timer -- vi.useFakeTimers() doesn't
    // intercept it, so asserting the real 10s wait would make this test genuinely slow. Stub
    // AbortSignal.timeout itself instead: confirms fetchJson requests exactly the configured timeout value,
    // and lets the test fire the abort immediately rather than waiting it out.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    const hangingFetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ ok: boolean }>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    await expect(fetchJson("https://api.gittensor.io/repos/x/impact", hangingFetch)).rejects.toThrow();
    expect(timeoutSpy).toHaveBeenCalledWith(GITTENSOR_IMPACT_CARD_FETCH_TIMEOUT_MS);
  });

  it("fetchGtLogoSvg returns the response body text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ text: async () => "<svg></svg>" });
    await expect(fetchGtLogoSvg(fetchImpl)).resolves.toBe("<svg></svg>");
  });

  it("fetchGtLogoSvg bounds its request with the configured AbortSignal.timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ text: async () => "<svg></svg>" });
    await fetchGtLogoSvg(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gittensor.io/gt-logo.svg",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("exposes the documented default timeout", () => {
    expect(GITTENSOR_IMPACT_CARD_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});
