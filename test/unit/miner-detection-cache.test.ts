import { describe, expect, it, vi } from "vitest";
import { isConfirmedOfficialMiner } from "../../src/gittensor/miner-detection-cache";
import { createTestEnv } from "../helpers/d1";

function stubMinerFetch(githubUsername: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.gittensor.io/miners") return Response.json([{ githubUsername, githubId: "123", totalPrs: 2, totalMergedPrs: 2, isEligible: true, credibility: 1 }]);
    if (url === "https://api.gittensor.io/miners/123/prs") return Response.json([]);
    if (url === "https://api.gittensor.io/miners/123") return Response.json({});
    if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") return Response.json({ issues: [] });
    return Response.json({});
  });
}

describe("isConfirmedOfficialMiner (#4513, shared with #4512's unlinked-issue-guardrail)", () => {
  it("resolves true for a login present in the /miners roster", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves false for a login absent from an empty /miners roster (not_found)", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return Response.json({});
    });
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves false (fail-safe) when the Gittensor API itself is unavailable", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a second call within the TTL hits the cache instead of re-fetching", async () => {
    const env = createTestEnv();
    const fetchMock = stubMinerFetch("farmer99");
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(true);
      const callsAfterFirst = fetchMock.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cache hit -- no additional fetch
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a cache READ failure falls back to a fresh fetch rather than a false negative", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/SELECT.*FROM.*official_miner_detections/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a cache WRITE failure still uses the freshly-fetched status for this call", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", stubMinerFetch("farmer99"));
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/INSERT INTO.*official_miner_detections/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    try {
      expect(await isConfirmedOfficialMiner(env, "farmer99")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
