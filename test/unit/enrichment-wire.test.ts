import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isEnrichmentEnabled,
  buildReviewEnrichment,
} from "../../src/review/enrichment-wire";

const env = (o: Record<string, string>) => o as unknown as Env;
const input = {
  repoFullName: "o/r",
  prNumber: 5,
  headSha: "abc",
  title: "t",
  files: [
    { path: "a.ts", payload: { patch: "@@ +1 @@" } },
    { path: "b.ts" },
  ] as never,
  diff: "the diff",
};

describe("isEnrichmentEnabled", () => {
  it("true only when the flag is on AND REES_URL is set", () => {
    expect(
      isEnrichmentEnabled(
        env({ GITTENSORY_REVIEW_ENRICHMENT: "on", REES_URL: "https://r" }),
      ),
    ).toBe(true);
    expect(
      isEnrichmentEnabled(
        env({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "https://r" }),
      ),
    ).toBe(true);
    expect(
      isEnrichmentEnabled(env({ GITTENSORY_REVIEW_ENRICHMENT: "on" })),
    ).toBe(false); // no URL
    expect(isEnrichmentEnabled(env({ REES_URL: "https://r" }))).toBe(false); // flag off
    expect(
      isEnrichmentEnabled(
        env({ GITTENSORY_REVIEW_ENRICHMENT: "false", REES_URL: "https://r" }),
      ),
    ).toBe(false);
    expect(isEnrichmentEnabled(env({}))).toBe(false);
  });
});

describe("buildReviewEnrichment", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the trimmed brief, sends the bearer + mapped files, honors REES_TIMEOUT_MS", async () => {
    const calls: Array<{ url: unknown; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          promptSection: "  BRIEF  ",
          systemSuffix: "suffix",
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const r = await buildReviewEnrichment(
      env({
        REES_URL: "https://rees/",
        REES_SHARED_SECRET: "sek",
        REES_TIMEOUT_MS: "12000",
      }),
      input,
    );
    expect(r).toEqual({ promptSection: "BRIEF", systemSuffix: "suffix" });
    expect(calls[0]!.url).toBe("https://rees/v1/enrich");
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer sek");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.repoFullName).toBe("o/r");
    expect(body.files).toEqual([
      { path: "a.ts", patch: "@@ +1 @@" },
      { path: "b.ts", patch: undefined },
    ]);
  });

  it("undefined when REES_URL is unset", async () => {
    expect(await buildReviewEnrichment(env({}), input)).toBeUndefined();
  });

  it("undefined on a non-200 response", async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;
    expect(
      await buildReviewEnrichment(env({ REES_URL: "https://r" }), input),
    ).toBeUndefined();
  });

  it("undefined on an empty promptSection (no findings)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ promptSection: "", systemSuffix: "x" }),
        }) as Response,
    ) as unknown as typeof fetch;
    expect(
      await buildReviewEnrichment(env({ REES_URL: "https://r" }), input),
    ).toBeUndefined();
  });

  it("undefined on a fetch throw (timeout/network) — fail-safe", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(
      await buildReviewEnrichment(env({ REES_URL: "https://r" }), input),
    ).toBeUndefined();
  });

  it("omits the bearer header when no secret, and defaults systemSuffix to empty", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      calls.push(init);
      return {
        ok: true,
        json: async () => ({ promptSection: "x" }),
      } as Response;
    }) as unknown as typeof fetch;
    const r = await buildReviewEnrichment(
      env({ REES_URL: "https://r" }),
      input,
    );
    expect(r).toEqual({ promptSection: "x", systemSuffix: "" });
    expect(
      (calls[0]!.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });
});
