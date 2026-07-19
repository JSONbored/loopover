import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

const logSpy = { info: vi.fn(), debug: vi.fn() };
vi.mock("../../packages/loopover-miner/lib/logger.js", () => ({
  getLogger: () => logSpy,
}));

import {
  DISCOVERY_INDEX_URL_FLAG,
  DISCOVERY_PLANE_FLAG,
  DISCOVERY_TELEMETRY_FLAG,
  isDiscoveryPlaneEnabled,
  isDiscoveryTelemetryEnabled,
  queryDiscoveryIndex,
  recordDiscoveryTelemetry,
  submitSoftClaim,
} from "../../packages/loopover-miner/lib/discovery-index-client.js";

const ENABLED_ENV = {
  [DISCOVERY_PLANE_FLAG]: "true",
  [DISCOVERY_INDEX_URL_FLAG]: "https://discovery.example.internal",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  logSpy.info.mockClear();
  logSpy.debug.mockClear();
});

describe("isDiscoveryPlaneEnabled / isDiscoveryTelemetryEnabled (#7168)", () => {
  it("defaults to disabled when unset", () => {
    expect(isDiscoveryPlaneEnabled({})).toBe(false);
    expect(isDiscoveryTelemetryEnabled({})).toBe(false);
  });

  it("accepts the documented truthy-string convention, rejects anything else", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isDiscoveryPlaneEnabled({ [DISCOVERY_PLANE_FLAG]: value })).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", "", "  "]) {
      expect(isDiscoveryPlaneEnabled({ [DISCOVERY_PLANE_FLAG]: value })).toBe(false);
    }
  });

  it("gates independently of each other", () => {
    expect(isDiscoveryTelemetryEnabled({ [DISCOVERY_PLANE_FLAG]: "true" })).toBe(false);
    expect(isDiscoveryPlaneEnabled({ [DISCOVERY_TELEMETRY_FLAG]: "true" })).toBe(false);
  });
});

describe("queryDiscoveryIndex (#7168)", () => {
  it("is a no-op when the plane is disabled", async () => {
    const fetchImpl = vi.fn();
    const response = await queryDiscoveryIndex({ repos: ["a/b"] }, { env: {}, fetchImpl });
    expect(response).toEqual({ contractVersion: 1, candidates: [], nextCursor: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when the plane is enabled but no URL is configured", async () => {
    const fetchImpl = vi.fn();
    const response = await queryDiscoveryIndex({ repos: ["a/b"] }, { env: { [DISCOVERY_PLANE_FLAG]: "true" }, fetchImpl });
    expect(response.candidates).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the normalized query and returns the normalized response when enabled", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://discovery.example.internal/v1/discovery-index/query");
      expect(JSON.parse(String(init.body))).toMatchObject({ repos: ["a/b"] });
      return Response.json({
        contractVersion: 1,
        candidates: [
          {
            repoFullName: "a/b",
            issueNumber: 1,
            title: "T",
            labels: [],
            commentsCount: 0,
            createdAt: null,
            updatedAt: null,
            htmlUrl: null,
            aiPolicyAllowed: true,
            aiPolicySource: "none",
          },
        ],
        nextCursor: null,
      });
    });
    const response = await queryDiscoveryIndex({ repos: ["a/b"] }, { env: ENABLED_ENV, fetchImpl });
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]).toMatchObject({ repoFullName: "a/b", issueNumber: 1 });
  });

  it("fails open (returns empty) on a non-ok response or a thrown error", async () => {
    const notOk = await queryDiscoveryIndex({ repos: ["a/b"] }, { env: ENABLED_ENV, fetchImpl: async () => new Response("err", { status: 500 }) });
    expect(notOk.candidates).toEqual([]);

    const threw = await queryDiscoveryIndex(
      { repos: ["a/b"] },
      {
        env: ENABLED_ENV,
        fetchImpl: async () => {
          throw new Error("network exploded");
        },
      },
    );
    expect(threw.candidates).toEqual([]);
  });
});

describe("submitSoftClaim (#7168)", () => {
  const validClaim = { repoFullName: "a/b", issueNumber: 1, claimedAt: "2026-07-19T00:00:00Z", status: "active" as const };

  it("is a no-op when the plane is disabled", async () => {
    const fetchImpl = vi.fn();
    expect(await submitSoftClaim(validClaim, { env: {}, fetchImpl })).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when no URL is configured", async () => {
    const fetchImpl = vi.fn();
    expect(await submitSoftClaim(validClaim, { env: { [DISCOVERY_PLANE_FLAG]: "true" }, fetchImpl })).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op without calling fetch when the claim doesn't build a valid request", async () => {
    const fetchImpl = vi.fn();
    const invalidClaim = { repoFullName: "no-slash", issueNumber: 1, claimedAt: "2026-07-19T00:00:00Z", status: "active" as const };
    expect(await submitSoftClaim(invalidClaim, { env: ENABLED_ENV, fetchImpl })).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the built request and reports sent:true on an ok response", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://discovery.example.internal/v1/discovery-index/soft-claim");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ repoFullName: "a/b", issueNumber: 1, action: "claim", note: null, instanceId: null });
      return Response.json({ contractVersion: 1, accepted: true, ageMs: null });
    });
    expect(await submitSoftClaim(validClaim, { env: ENABLED_ENV, fetchImpl })).toEqual({ sent: true });
  });

  it("derives a release action from a released status", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ action: "release" });
      return Response.json({ contractVersion: 1, accepted: true, ageMs: null });
    });
    await submitSoftClaim({ ...validClaim, status: "released" }, { env: ENABLED_ENV, fetchImpl });
  });

  it("fails open and logs on a non-ok response or a thrown error", async () => {
    const notOk = await submitSoftClaim(validClaim, { env: ENABLED_ENV, fetchImpl: async () => new Response("err", { status: 500 }) });
    expect(notOk).toEqual({ sent: false });

    const threw = await submitSoftClaim(validClaim, {
      env: ENABLED_ENV,
      fetchImpl: async () => {
        throw new Error("network exploded");
      },
    });
    expect(threw).toEqual({ sent: false });
    expect(logSpy.debug).toHaveBeenCalledWith("discovery_plane_soft_claim_failed", expect.objectContaining({ error: expect.stringContaining("network exploded") }));
  });
});

describe("recordDiscoveryTelemetry (#7168)", () => {
  it("emits nothing when the plane is disabled", () => {
    recordDiscoveryTelemetry("discover_query", "supplemented", { env: {} });
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it("emits nothing when the plane is enabled but telemetry is not", () => {
    recordDiscoveryTelemetry("discover_query", "supplemented", { env: { [DISCOVERY_PLANE_FLAG]: "true" } });
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it("emits a low-cardinality event when both opt-ins are enabled", () => {
    recordDiscoveryTelemetry("discover_query", "supplemented", {
      env: { [DISCOVERY_PLANE_FLAG]: "true", [DISCOVERY_TELEMETRY_FLAG]: "true" },
    });
    expect(logSpy.info).toHaveBeenCalledWith("discovery_plane_telemetry", { event: "discover_query", outcome: "supplemented" });
  });
});

describe("defaulted options (real process.env / real global fetch) (#7168)", () => {
  it("queryDiscoveryIndex falls back to process.env and stays a safe no-op when neither opt-in var is set there", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const response = await queryDiscoveryIndex({ repos: ["a/b"] });
    expect(response).toEqual({ contractVersion: 1, candidates: [], nextCursor: null });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("submitSoftClaim falls back to process.env and stays a safe no-op when the plane isn't set there", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const result = await submitSoftClaim({ repoFullName: "a/b", issueNumber: 1, claimedAt: "2026-07-19T00:00:00Z", status: "active" as const });
    expect(result).toEqual({ sent: false });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("recordDiscoveryTelemetry falls back to process.env and emits nothing when unset there", () => {
    recordDiscoveryTelemetry("discover_query", "empty");
    expect(logSpy.info).not.toHaveBeenCalled();
  });

  it("queryDiscoveryIndex falls back to the real global fetch when no fetchImpl is injected", async () => {
    vi.stubEnv(DISCOVERY_PLANE_FLAG, "true");
    vi.stubEnv(DISCOVERY_INDEX_URL_FLAG, "https://discovery.example.internal");
    const globalFetch = vi.fn(async () => Response.json({ contractVersion: 1, candidates: [], nextCursor: null }));
    vi.stubGlobal("fetch", globalFetch);
    const response = await queryDiscoveryIndex({ repos: ["a/b"] });
    expect(response.candidates).toEqual([]);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it("submitSoftClaim falls back to the real global fetch when no fetchImpl is injected", async () => {
    vi.stubEnv(DISCOVERY_PLANE_FLAG, "true");
    vi.stubEnv(DISCOVERY_INDEX_URL_FLAG, "https://discovery.example.internal");
    const globalFetch = vi.fn(async () => Response.json({ contractVersion: 1, accepted: true, ageMs: null }));
    vi.stubGlobal("fetch", globalFetch);
    const result = await submitSoftClaim({ repoFullName: "a/b", issueNumber: 1, claimedAt: "2026-07-19T00:00:00Z", status: "active" as const });
    expect(result).toEqual({ sent: true });
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("authHeaders and response-parsing edge cases (#7168)", () => {
  it("includes a bearer authorization header when a shared secret is configured", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer topsecret");
      return Response.json({ contractVersion: 1, candidates: [], nextCursor: null });
    });
    await queryDiscoveryIndex(
      { repos: ["a/b"] },
      { env: { ...ENABLED_ENV, LOOPOVER_MINER_DISCOVERY_SHARED_SECRET: "topsecret" }, fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("omits the authorization header when no shared secret is configured", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return Response.json({ contractVersion: 1, candidates: [], nextCursor: null });
    });
    await queryDiscoveryIndex({ repos: ["a/b"] }, { env: ENABLED_ENV, fetchImpl });
  });

  it("degrades to an empty response when the server returns an unparseable JSON body", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));
    const response = await queryDiscoveryIndex({ repos: ["a/b"] }, { env: ENABLED_ENV, fetchImpl });
    expect(response).toEqual({ contractVersion: 1, candidates: [], nextCursor: null });
  });
});
