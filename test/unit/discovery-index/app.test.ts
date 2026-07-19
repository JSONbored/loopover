import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiPolicyVerdict, DiscoveryIndexCandidate } from "@loopover/engine";
import { createApp, type AppDeps } from "../../../packages/discovery-index/src/app";
import { TtlCache } from "../../../packages/discovery-index/src/cache";
import { resetMetrics } from "../../../packages/discovery-index/src/metrics";
import type { GitHubClientLike } from "../../../packages/discovery-index/src/discovery-query";
import { SoftClaimStore } from "../../../packages/discovery-index/src/soft-claim";

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const github: GitHubClientLike = {
    async fetchRepoIssues(repoFullName: string) {
      return { issues: repoFullName === "acme/widgets" ? [{ number: 1, title: "Fix it" }] : [], warnings: [] };
    },
    async searchIssues() {
      return { issues: [], warnings: [] };
    },
    async fetchRepoFile() {
      return { content: null };
    },
  };
  return {
    github,
    resultCache: new TtlCache<DiscoveryIndexCandidate[]>(),
    policyCache: new TtlCache<AiPolicyVerdict>(),
    cacheTtlMs: 300_000,
    softClaimStore: new SoftClaimStore(new TtlCache(), 1_800_000),
    githubConfigured: true,
    ...overrides,
  };
}

describe("discovery-index Hono app (#7164)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMetrics();
  });

  it("GET /health reports liveness", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "discovery-index" });
  });

  it("GET /ready reports 200 when the GitHub token is configured, 503 otherwise", async () => {
    const ready = await createApp(makeDeps({ githubConfigured: true })).request("/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });

    const notReady = await createApp(makeDeps({ githubConfigured: false })).request("/ready");
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ ready: false });
  });

  it("GET /metrics renders Prometheus text after a request has been recorded", async () => {
    vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
    const app = createApp(makeDeps());
    await app.request("/v1/discovery-index/query", {
      method: "POST",
      headers: { authorization: "Bearer sek", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("discovery_index_query_requests_total");
  });

  describe("POST /v1/discovery-index/query", () => {
    it("fails closed with 503 when no shared secret is configured", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "service_not_configured" });
    });

    it("returns 401 for a missing or incorrect bearer token", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const noAuth = await app.request("/v1/discovery-index/query", { method: "POST", body: JSON.stringify({}) });
      expect(noAuth.status).toBe(401);

      const wrongAuth = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { authorization: "Bearer nope" },
        body: JSON.stringify({}),
      });
      expect(wrongAuth.status).toBe(401);
    });

    it("returns 400 for an unparseable JSON body", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_json" });
    });

    it("accepts a valid empty body as an empty query and returns 200", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ candidates: [], nextCursor: null });
    });

    it("returns 200 with candidates for a valid authenticated request", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({ repos: ["acme/widgets"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { candidates: unknown[] };
      expect(body.candidates).toHaveLength(1);
    });

    it("returns 500 via the centralized error handler when the query pipeline throws", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const failingGithub: GitHubClientLike = {
        async fetchRepoIssues() {
          throw new Error("network exploded");
        },
        async searchIssues() {
          return { issues: [], warnings: [] };
        },
        async fetchRepoFile() {
          return { content: null };
        },
      };
      const app = createApp(makeDeps({ github: failingGithub }));
      const res = await app.request("/v1/discovery-index/query", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({ repos: ["acme/widgets"] }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
    });
  });

  describe("POST /v1/discovery-index/soft-claim", () => {
    it("fails closed with 503 when no shared secret is configured", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 1, action: "claim" }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "service_not_configured" });
    });

    it("returns 401 for a missing or incorrect bearer token", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 1, action: "claim" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for an unparseable JSON body", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_json" });
    });

    it("returns 400 for a structurally invalid request", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "no-slash", issueNumber: 1, action: "claim" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    });

    it("accepts a fresh claim, reports an already-held repeat claim with its age, then accepts again after release", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const deps = makeDeps();
      const app = createApp(deps);
      const claimReq = () =>
        app.request("/v1/discovery-index/soft-claim", {
          method: "POST",
          headers: { authorization: "Bearer sek", "content-type": "application/json" },
          body: JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 1, action: "claim" }),
        });

      const first = await claimReq();
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ accepted: true, ageMs: null });

      const second = await claimReq();
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { accepted: boolean; ageMs: number | null };
      expect(secondBody.accepted).toBe(false);
      expect(secondBody.ageMs).toBeGreaterThanOrEqual(0);

      const release = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 1, action: "release" }),
      });
      expect(release.status).toBe(200);
      expect(await release.json()).toMatchObject({ accepted: true, ageMs: null });

      const third = await claimReq();
      expect(await third.json()).toMatchObject({ accepted: true, ageMs: null });
    });

    it("never echoes forbidden or identity-shaped fields even when the caller sends them", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const app = createApp(makeDeps());
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({
          repoFullName: "acme/widgets",
          issueNumber: 1,
          action: "claim",
          note: "look at me",
          instanceId: "instance-123",
          reward: 999,
          wallet: "0xdeadbeef",
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["accepted", "ageMs", "contractVersion"]);
    });

    it("returns 500 via the centralized error handler when the store throws", async () => {
      vi.stubEnv("DISCOVERY_INDEX_SHARED_SECRET", "sek");
      const throwingStore = {
        claim() {
          throw new Error("store exploded");
        },
        release() {
          throw new Error("store exploded");
        },
      };
      const app = createApp(makeDeps({ softClaimStore: throwingStore }));
      const res = await app.request("/v1/discovery-index/soft-claim", {
        method: "POST",
        headers: { authorization: "Bearer sek", "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 1, action: "claim" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
    });
  });
});
