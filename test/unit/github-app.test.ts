import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  cancelInFlightWorkflowRunsForHeadSha,
  clearInstallationTokenCacheForTest,
  createInstallationToken,
  createOrUpdateCheckRun,
  isCrossAppCheckRunError,
  createOrUpdateGateCheckRun,
  createOrUpdatePendingGateCheckRun,
  createOrUpdateSkippedGateCheckRun,
  getAppInstallation,
  getGithubUserCreatedAt,
  getInstallationId,
  getRepositoryCollaboratorPermission,
  isCacheableGithubUrl,
  isCheckRunPermissionError,
  isForeignAppInstallation,
  isGitHubBadCredentialsError,
  isGitHubRateLimitedError,
  isRateLimitedResponse,
  rateLimitRetryMs,
  setGitHubResponseCache,
  setInstallationTokenStore,
  withInstallationTokenRetry,
} from "../../src/github/app";
import type { Advisory } from "../../src/types";
import { createTestEnv } from "../helpers/d1";
import { getInstallation, listLatestGitHubRateLimitObservations, upsertInstallation } from "../../src/db/repositories";
import { clockSkewSecondsSample, resetClockSkewForTest } from "../../src/selfhost/clock-skew";

beforeEach(() => {
  clearInstallationTokenCacheForTest();
  resetClockSkewForTest();
});

describe("GitHub check runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a completed Gittensory check run with an installation token", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push(url);
        if (url.includes("/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        if (url.includes("/commits/abc123/check-runs")) {
          return Response.json({ total_count: 0, check_runs: [] });
        }
        if (url.includes("/check-runs")) {
          const body = JSON.parse(String(init?.body)) as {
            name: string;
            conclusion: string;
            output: { title: string; text: string };
          };
          expect(body.name).toBe("Gittensory Context");
          expect(body.conclusion).toBe("neutral");
          expect(body.output.title).toBe("Gittensory context posted");
          expect(body.output.text).not.toMatch(
            /linked issue|reviewability|reward|farming|wallet|hotkey|trust score/i,
          );
          return Response.json(
            { id: 42, html_url: "https://github.com/checks/42" },
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-1",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 1,
      headSha: "abc123",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [
        {
          code: "missing_linked_issue",
          title: "No linked issue detected",
          severity: "warning",
          detail: "No closing reference was found.",
        },
      ],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );

    expect(result).toMatchObject({ kind: "published", id: 42 });
    expect(
      calls.some((url) => url.includes("/app/installations/123/access_tokens")),
    ).toBe(true);
    expect(
      calls.some((url) =>
        url.includes("/repos/JSONbored/gittensory/check-runs"),
      ),
    ).toBe(true);
  });

  it("returns no published check-run outcome for dry-run suppressed writes", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs"))
          return Response.json({ check_runs: [] });
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const result = await createOrUpdateGateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      gateAdvisory("dry-run-gate"),
      {},
      {},
      "dry_run",
    );

    expect(result).toBeNull();
    expect(
      calls.some(
        (call) => call.startsWith("POST ") && call.includes("/check-runs"),
      ),
    ).toBe(false);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE event_type = ?",
    )
      .bind("github.write.suppressed")
      .first<{ detail: string }>();
    expect(audit?.detail).toContain("suppressed POST");
  });

  it("accepts GitHub App RSA private key PEMs for installation tokens", async () => {
    const privateKey = generateRsaPrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });

    await expect(
      createInstallationToken(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
      ),
    ).resolves.toBe("installation-token");
  });

  it("caches an installation token and reuses it within the validity window", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mints = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: `installation-token-${mints}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const first = await createInstallationToken(env, 555);
    const second = await createInstallationToken(env, 555);

    expect(first).toBe("installation-token-1");
    expect(second).toBe("installation-token-1");
    expect(mints).toBe(1);
  });

  it("(#3811) samples clock skew from the installation-token mint response's Date header", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z")); // 5 minutes ahead of the stubbed response's Date
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }), {
          headers: { "content-type": "application/json", date: "Mon, 06 Jul 2026 12:00:00 GMT" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await createInstallationToken(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 4242);
    expect(clockSkewSecondsSample()).toBe(300);
    vi.useRealTimers();
  });

  it("REGRESSION (#2453): evicts a rejected App JWT and retries the mint once instead of failing outright", async () => {
    // Unlike installation tokens (evicted + retried once by withInstallationTokenRetry), the App JWT itself had
    // no eviction path before #2453: mintInstallationToken threw straight through on the first non-ok response,
    // with no retry attempt at all, leaving the poisoned JWT cached for up to APP_JWT_REUSE_MS (8 min) and
    // failing every installation-token mint on the instance in the meantime. Before this fix, mintCalls would be
    // 1 and the overall call would reject; after it, exactly one retry recovers the mint.
    const privateKey = await generatePrivateKeyPem();
    let mintCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mintCalls += 1;
        if (mintCalls === 1) return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json({ token: "fresh-installation-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    await expect(createInstallationToken(env, 777)).resolves.toBe("fresh-installation-token");
    expect(mintCalls).toBe(2); // exactly one bounded retry, not zero (old behavior) or unbounded
  });

  it("REGRESSION (#2453): does not infinite-loop when the retried App JWT is ALSO rejected", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mintCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mintCalls += 1;
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    await expect(createInstallationToken(env, 777)).rejects.toThrow(/Failed to create GitHub installation token \(401\)/);
    expect(mintCalls).toBe(2); // bounded to exactly one retry, never an unbounded loop
  });

  it("REGRESSION (#2453, second pass — flagged by the gate's own review): evicts the App JWT again when the RETRIED JWT is ALSO rejected, so the NEXT mint attempt does not replay the poisoned JWT", async () => {
    // createAppJwt caches optimistically (before the POST proves the JWT valid). Without a second eviction, the
    // just-rejected retry JWT from the FIRST createInstallationToken call would sit in the cache and get replayed
    // by a SECOND, independent createInstallationToken call — still failing every mint fleet-wide for up to
    // APP_JWT_REUSE_MS, exactly the bug the eviction-on-401 fix exists to prevent. Fake timers advance the clock a
    // few seconds between the two top-level calls (still far inside the 8-minute reuse window) so a genuinely
    // fresh sign produces a different iat and a different Authorization header — RS256 signs an identical JWT for
    // an identical iat/exp within the same second, so comparing headers without advancing the clock would be
    // flaky (a false pass could occur even without eviction, purely from a same-second coincidence).
    vi.useFakeTimers();
    try {
      const privateKey = await generatePrivateKeyPem();
      const authHeaders: string[] = [];
      let mintCalls = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) {
          mintCalls += 1;
          authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
          if (mintCalls <= 2) return Response.json({ message: "Bad credentials" }, { status: 401 });
          return Response.json({ token: "recovered-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
        }
        return new Response("not found", { status: 404 });
      });

      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
      await expect(createInstallationToken(env, 777)).rejects.toThrow(/Failed to create GitHub installation token \(401\)/);
      expect(mintCalls).toBe(2);
      const retryHeader = authHeaders[1];

      await vi.advanceTimersByTimeAsync(5_000); // still well inside APP_JWT_REUSE_MS (8 min) — isolates eviction, not TTL expiry
      await expect(createInstallationToken(env, 777)).resolves.toBe("recovered-token");
      expect(mintCalls).toBe(3);
      // If the retry-rejected JWT had NOT been evicted, this third call would replay the cached (still within its
      // reuse window) poisoned JWT, producing the SAME Authorization header as the retry above.
      expect(authHeaders[2]).not.toBe(retryHeader);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a rejected cached installation token and retries check-run publication once", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mints = 0;
    let rejectedReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: mints === 1 ? "stale-token" : "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.includes("/commits/stale-head/check-runs") && auth.includes("stale-token")) {
        rejectedReads += 1;
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (url.includes("/commits/stale-head/check-runs")) {
        expect(auth).toContain("fresh-token");
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/check-runs") && init?.method === "POST") {
        expect(auth).toContain("fresh-token");
        return Response.json({ id: 556, html_url: "https://github.com/checks/556" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      556,
      "JSONbored/gittensory",
      gateAdvisory("stale-head"),
    );

    expect(result).toMatchObject({ kind: "published", id: 556 });
    expect(mints).toBe(2);
    expect(rejectedReads).toBe(1);
  });

  it("retries a rejected cached installation token when cache eviction fails", async () => {
    const privateKey = await generatePrivateKeyPem();
    let gets = 0;
    let evictionWrites = 0;
    setInstallationTokenStore({
      get: async () => {
        gets += 1;
        if (gets <= 2)
          return {
            token: "stale-token",
            expiresAtMs: Date.now() + 60 * 60_000,
          };
        return null;
      },
      set: async (_installationId, value) => {
        if (value.token === "") {
          evictionWrites += 1;
          throw new Error("token cache unavailable");
        }
      },
    });
    let mints = 0;
    let rejectedReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.includes("/commits/stale-head/check-runs") && auth.includes("stale-token")) {
        rejectedReads += 1;
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (url.includes("/commits/stale-head/check-runs")) {
        expect(auth).toContain("fresh-token");
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (url.includes("/check-runs") && init?.method === "POST") {
        expect(auth).toContain("fresh-token");
        return Response.json({ id: 557, html_url: "https://github.com/checks/557" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      557,
      "JSONbored/gittensory",
      gateAdvisory("stale-head"),
    );

    expect(result).toMatchObject({ kind: "published", id: 557 });
    expect(evictionWrites).toBe(1);
    expect(mints).toBe(1);
    expect(rejectedReads).toBe(1);
  });

  it("does not evict a newer cached installation token when the rejected token is already stale", async () => {
    const reads = [
      { token: "rejected-token", expiresAtMs: Date.now() + 60 * 60_000 },
      { token: "replacement-token", expiresAtMs: Date.now() + 60 * 60_000 },
      { token: "replacement-token", expiresAtMs: Date.now() + 60 * 60_000 },
    ];
    const writes: Array<{ token: string; expiresAtMs: number }> = [];
    setInstallationTokenStore({
      get: async () => reads.shift() ?? null,
      set: async (_installationId, value) => {
        writes.push(value);
      },
    });
    const seenTokens: string[] = [];

    const result = await withInstallationTokenRetry(createTestEnv(), 558, async (token) => {
      seenTokens.push(token);
      if (token === "rejected-token")
        throw { response: { status: 401 }, message: "token expired" };
      return "ok";
    });

    expect(result).toBe("ok");
    expect(seenTokens).toEqual(["rejected-token", "replacement-token"]);
    expect(writes).toEqual([]);
    expect(isGitHubBadCredentialsError(new Error("Bad credentials"))).toBe(true);
    expect(isGitHubBadCredentialsError({ response: { status: 401 }, message: "Unauthorized" })).toBe(true);
  });

  it("does not treat primitive values as GitHub rate-limit errors", () => {
    expect(isGitHubRateLimitedError("secondary rate limit")).toBe(false);
    expect(isGitHubRateLimitedError(null)).toBe(false);
  });

  it("single-flights concurrent cold-cache mints for one install (no thundering herd)", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mints = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: `installation-token-${mints}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    // Ten concurrent callers on a COLD cache → exactly ONE mint (single-flight); all share the same token. Without
    // coalescing this would be ten mints — the herd that secondary-rate-limits the Orb broker on a cold start.
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => createInstallationToken(env, 4242)),
    );
    expect(new Set(tokens)).toEqual(new Set(["installation-token-1"]));
    expect(mints).toBe(1);
  });

  it("re-mints an installation token once the cached one is within the expiry safety margin", async () => {
    const privateKey = await generatePrivateKeyPem();
    let mints = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        mints += 1;
        // First mint expires almost immediately (inside the 2-minute safety margin) → must not be reused.
        const expiresInMs = mints === 1 ? 30_000 : 60 * 60_000;
        return Response.json({
          token: `installation-token-${mints}`,
          expires_at: new Date(Date.now() + expiresInMs).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const first = await createInstallationToken(env, 777);
    const second = await createInstallationToken(env, 777);

    expect(first).toBe("installation-token-1");
    expect(second).toBe("installation-token-2");
    expect(mints).toBe(2);
  });

  it("sources the installation token from the Orb broker when an enrollment secret is set (and caches it)", async () => {
    let brokerCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/v1/orb/token")) {
        brokerCalls += 1;
        return Response.json({
          token: "brokered-token",
          installationId: 999,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    // No GITHUB_APP_PRIVATE_KEY needed — a brokered self-host holds no App key.
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    expect(await createInstallationToken(env, 888)).toBe("brokered-token");
    expect(await createInstallationToken(env, 888)).toBe("brokered-token"); // cached → no second broker exchange
    expect(brokerCalls).toBe(1);
  });

  it("persists broker-returned installation permissions so runtime readiness sees accepted scopes", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    await upsertInstallation(env, {
      installation: {
        id: 889,
        account: { login: "owner", id: 1, type: "User" },
        target_type: "User",
        repository_selection: "selected",
        permissions: { contents: "read", pull_requests: "write" },
        events: [],
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/v1/orb/token")) {
        return Response.json({
          token: "brokered-token",
          installationId: 889,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", pull_requests: "write" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await createInstallationToken(env, 889);

    expect((await getInstallation(env, 889))?.permissions).toEqual({ contents: "write", pull_requests: "write" });
  });

  it("force-remints the broker token once when GitHub rejects a stale permission scope", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    const brokerBodies: Array<string | undefined> = [];
    let brokerCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().includes("/v1/orb/token")) {
        brokerCalls += 1;
        brokerBodies.push(init?.body === undefined ? undefined : String(init.body));
        return Response.json({
          token: brokerCalls === 1 ? "stale-scope-token" : "fresh-scope-token",
          installationId: 890,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: brokerCalls === 1 ? { contents: "read" } : { contents: "write" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const seenTokens: string[] = [];

    const result = await withInstallationTokenRetry(env, 890, async (token) => {
      seenTokens.push(token);
      if (token === "stale-scope-token") {
        const error = new Error("Resource not accessible by integration") as Error & { status: number };
        error.status = 403;
        throw error;
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(seenTokens).toEqual(["stale-scope-token", "fresh-scope-token"]);
    expect(brokerBodies).toEqual([undefined, JSON.stringify({ forceRefresh: true })]);
  });

  it("#2: serves a still-valid cached token when the Orb mint fails (stale-token grace, no fleet stall)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/v1/orb/token")) {
        calls += 1;
        // First mint returns a token expiring within the 2-min safety margin → the next call re-mints; that re-mint fails.
        if (calls === 1)
          return Response.json({
            token: "tok-1",
            installationId: 1001,
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
          });
        return new Response("orb down", { status: 503 });
      }
      return new Response("nf", { status: 404 });
    });
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    expect(await createInstallationToken(env, 1001)).toBe("tok-1"); // caches a near-expiry token
    expect(await createInstallationToken(env, 1001)).toBe("tok-1"); // re-mint fails → grace serves the still-valid cached token
    expect(calls).toBe(2); // the second call DID attempt a re-mint, then fell back to the cache
  });

  it("#2: rethrows when the broker is down and there is no still-valid cached token", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/v1/orb/token"))
        return new Response("orb down", { status: 503 });
      return new Response("nf", { status: 404 });
    });
    await expect(
      createInstallationToken(
        createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" }),
        1002,
      ),
    ).rejects.toThrow();
  });

  it("#2: rethrows when the only cached token has actually expired (no dangerous reuse)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/v1/orb/token")) {
        calls += 1;
        if (calls === 1)
          return Response.json({
            token: "tok-old",
            installationId: 1003,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          });
        return new Response("orb down", { status: 503 });
      }
      return new Response("nf", { status: 404 });
    });
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_test" });
    expect(await createInstallationToken(env, 1003)).toBe("tok-old"); // caches an already-expired token
    await expect(createInstallationToken(env, 1003)).rejects.toThrow(); // re-mint fails + cached expired → rethrow
  });

  it("fetches repository collaborator permissions with installation credentials", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (
        url.endsWith(
          "/repos/JSONbored/gittensory/collaborators/maintainer/permission",
        )
      )
        return Response.json({ permission: "maintain" });
      return new Response("not found", { status: 404 });
    });

    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        "maintainer",
      ),
    ).resolves.toBe("maintain");
    expect(
      calls.some((url) => url.includes("/app/installations/123/access_tokens")),
    ).toBe(true);
  });

  it("handles missing repository collaborator permission responses", async () => {
    const privateKey = await generatePrivateKeyPem();

    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "invalid",
        "maintainer",
      ),
    ).resolves.toBeNull();
    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        "",
      ),
    ).resolves.toBeNull();

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/collaborators/missing/permission"))
        return new Response("missing", { status: 404 });
      if (url.includes("/collaborators/no-permission/permission"))
        return Response.json({});
      if (url.includes("/collaborators/error/permission"))
        return new Response("permission unavailable", { status: 500 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        "missing",
      ),
    ).resolves.toBeNull();
    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        "no-permission",
      ),
    ).resolves.toBeNull();
    await expect(
      getRepositoryCollaboratorPermission(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        "error",
      ),
    ).rejects.toThrow(/Failed to fetch GitHub collaborator permission/);
  });

  it("getGithubUserCreatedAt fetches the account creation date, and fails OPEN (null) on any error (#2561)", async () => {
    const privateKey = await generatePrivateKeyPem();
    await expect(getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "")).resolves.toBeNull();

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/users/newbie")) return Response.json({ login: "newbie", created_at: "2026-06-01T00:00:00Z" });
      if (url.includes("/users/missing-field")) return Response.json({ login: "missing-field" });
      if (url.includes("/users/malformed-field")) return Response.json({ login: "malformed-field", created_at: 12345 });
      if (url.includes("/users/not-found")) return new Response("not found", { status: 404 });
      if (url.includes("/users/network-error")) throw new Error("network down");
      return new Response("not found", { status: 404 });
    });

    await expect(
      getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "newbie"),
    ).resolves.toBe("2026-06-01T00:00:00Z");
    await expect(
      getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "missing-field"),
    ).resolves.toBeNull();
    // Gate finding (#2561): a malformed (non-string) created_at must fail open, not be coerced by Date.parse.
    await expect(
      getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "malformed-field"),
    ).resolves.toBeNull();
    await expect(
      getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "not-found"),
    ).resolves.toBeNull();
    await expect(
      getGithubUserCreatedAt(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "network-error"),
    ).resolves.toBeNull();
  });

  it("cancelInFlightWorkflowRunsForHeadSha lists in_progress + queued runs at a head SHA and cancels each (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const cancelledIds: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=abc123&status=in_progress")) return Response.json({ workflow_runs: [{ id: 1, event: "pull_request", pull_requests: [{ number: 55 }] }, { id: 2, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=abc123&status=queued")) return Response.json({ workflow_runs: [{ id: 3, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") {
        cancelledIds.push(Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1]));
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "abc123", 55);
    expect(outcome).toEqual({ kind: "cancelled", cancelledCount: 3, totalFound: 3 });
    expect(cancelledIds.sort()).toEqual([1, 2, 3]);
  });

  it("cancelInFlightWorkflowRunsForHeadSha only cancels workflow runs attached to the closed PR", async () => {
    const privateKey = await generatePrivateKeyPem();
    const cancelledIds: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=shared-sha&status=in_progress")) {
        return Response.json({
          workflow_runs: [
            { id: 101, event: "pull_request", pull_requests: [{ number: 55 }] },
            { id: 202, event: "pull_request", pull_requests: [{ number: 56 }] },
            { id: 303, event: "push", pull_requests: [{ number: 55 }] },
            { id: 404, event: "workflow_dispatch", pull_requests: [] },
            { id: 505, event: "pull_request", pull_requests: null },
            { id: 606, event: "pull_request_target", pull_requests: [{ number: 55 }] },
          ],
        });
      }
      if (url.includes("/actions/runs?head_sha=shared-sha&status=queued")) return Response.json({ workflow_runs: [] });
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") {
        cancelledIds.push(Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1]));
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "shared-sha", 55);
    expect(outcome).toEqual({ kind: "cancelled", cancelledCount: 2, totalFound: 2 });
    expect(cancelledIds.sort()).toEqual([101, 606]);
  });

  it("cancelInFlightWorkflowRunsForHeadSha (gate finding) follows Link: rel=\"next\" pagination — a head SHA with MORE than one page of in_progress runs still gets every page cancelled", async () => {
    const privateKey = await generatePrivateKeyPem();
    const cancelledIds: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=multipage&status=in_progress&per_page=100&page=1")) {
        return new Response(JSON.stringify({ workflow_runs: [{ id: 1, event: "pull_request", pull_requests: [{ number: 55 }] }, { id: 2, event: "pull_request", pull_requests: [{ number: 55 }] }] }), { headers: { link: '<https://api.github.com/repos/owner/repo/actions/runs?head_sha=multipage&status=in_progress&per_page=100&page=2>; rel="next"' } });
      }
      if (url.includes("/actions/runs?head_sha=multipage&status=in_progress&per_page=100&page=2")) {
        return Response.json({ workflow_runs: [{ id: 3, event: "pull_request", pull_requests: [{ number: 55 }] }] }); // no Link header — last page
      }
      if (url.includes("/actions/runs?head_sha=multipage&status=queued")) return Response.json({ workflow_runs: [] });
      if (url.includes("/actions/runs/") && url.endsWith("/cancel") && method === "POST") {
        cancelledIds.push(Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1]));
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "multipage", 55);
    expect(outcome).toEqual({ kind: "cancelled", cancelledCount: 3, totalFound: 3 });
    expect(cancelledIds.sort()).toEqual([1, 2, 3]);
  });

  it("cancelInFlightWorkflowRunsForHeadSha returns cancelled with zero counts when no runs are found (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ workflow_runs: [] });
      return new Response("not found", { status: 404 });
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "no-runs-sha", 55),
    ).resolves.toEqual({ kind: "cancelled", cancelledCount: 0, totalFound: 0 });
  });

  it("cancelInFlightWorkflowRunsForHeadSha treats a 409 (already completed/cancelling) as a non-failure (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=in_progress")) return Response.json({ workflow_runs: [{ id: 9, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=queued")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/actions/runs/9/cancel") && method === "POST") return Response.json({ message: "already completed" }, { status: 409 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha409", 55),
    ).resolves.toEqual({ kind: "cancelled", cancelledCount: 1, totalFound: 1 });
  });

  it("cancelInFlightWorkflowRunsForHeadSha returns permission_missing on a genuine 403 while listing (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha403", 55);
    expect(outcome.kind).toBe("permission_missing");
    expect((outcome as { warning: string }).warning).toMatch(/actions: write permission is missing/i);
  });

  it("cancelInFlightWorkflowRunsForHeadSha returns permission_missing on a genuine 403 while cancelling (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=in_progress")) return Response.json({ workflow_runs: [{ id: 5, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=queued")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/actions/runs/5/cancel") && method === "POST") return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha403cancel", 55);
    expect(outcome.kind).toBe("permission_missing");
  });

  it("cancelInFlightWorkflowRunsForHeadSha does NOT classify a rate-limited 403 as permission_missing (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=")) return Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403 });
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-ratelimited", 55);
    expect(outcome.kind).toBe("error");
  });

  it("cancelInFlightWorkflowRunsForHeadSha returns an error result (never throws) on a network failure (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      throw new Error("network down");
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-network-error", 55),
    ).resolves.toEqual({ kind: "error", warning: "network down" });
  });

  it("cancelInFlightWorkflowRunsForHeadSha returns an error result for a malformed repoFullName (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "not-a-valid-repo-name", "sha", 55);
    expect(outcome.kind).toBe("error");
  });

  it("cancelInFlightWorkflowRunsForHeadSha falls back to a generic warning when a 403 body carries no message (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      // No `message` field at all -- exercises the `message === ""` branch of isActionsPermissionMissingMessage
      // AND the `message || "resource not accessible..."` fallback inside the warning string.
      if (url.includes("/actions/runs?head_sha=")) return Response.json({}, { status: 403 });
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-no-message", 55);
    expect(outcome.kind).toBe("permission_missing");
    expect((outcome as { warning: string }).warning).toContain("resource not accessible by integration");
  });

  it("cancelInFlightWorkflowRunsForHeadSha treats a workflow_runs-less list response as zero runs (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      // No `workflow_runs` field at all -- exercises the `payload.workflow_runs ?? []` fallback.
      if (url.includes("/actions/runs?head_sha=")) return Response.json({});
      return new Response("not found", { status: 404 });
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-no-workflow-runs-field", 55),
    ).resolves.toEqual({ kind: "cancelled", cancelledCount: 0, totalFound: 0 });
  });

  it("cancelInFlightWorkflowRunsForHeadSha reports a non-Error thrown value with a generic warning (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      throw "a bare string, not an Error instance";
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-non-error-throw", 55),
    ).resolves.toEqual({ kind: "error", warning: "unknown error" });
  });

  it("cancelInFlightWorkflowRunsForHeadSha reports the generic list-error branch with a fallback message when the body carries none (#2462)", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      // A non-403, non-ok status with no message -- exercises the `message || "unknown error"` fallback in the
      // generic error path (distinct from the permission_missing path exercised by other tests above).
      if (url.includes("/actions/runs?head_sha=")) return new Response(null, { status: 500 });
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-list-500", 55);
    expect(outcome).toEqual({ kind: "error", warning: "Failed to list workflow runs (500): unknown error" });
  });

  it("cancelInFlightWorkflowRunsForHeadSha (#gate finding) returns a typed error — never silently reports success — when a cancel call hits a non-permission error", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=in_progress")) return Response.json({ workflow_runs: [{ id: 42, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=queued")) return Response.json({ workflow_runs: [] });
      // Neither ok/409 (cancelled) nor a genuine permission-missing 403 -- a transient 500 must surface as a
      // typed `error` result, not be silently dropped and reported as `kind: "cancelled"` with an undercounted
      // cancelledCount (the exact bug a gate review caught: a 500/404/422 audited as a successful cancellation).
      if (url.endsWith("/actions/runs/42/cancel") && method === "POST") return new Response(null, { status: 500 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-cancel-500", 55),
    ).resolves.toEqual({ kind: "error", warning: expect.stringContaining("Failed to cancel workflow run 42 (500)") });
  });

  it("cancelInFlightWorkflowRunsForHeadSha (#gate finding) returns a typed error, not permission_missing, for a rate-limited 403 on the CANCEL call", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=in_progress")) return Response.json({ workflow_runs: [{ id: 43, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=queued")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/actions/runs/43/cancel") && method === "POST") return Response.json({ message: "secondary rate limit exceeded" }, { status: 403 });
      return new Response("not found", { status: 404 });
    });

    await expect(
      cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-cancel-ratelimited", 55),
    ).resolves.toEqual({ kind: "error", warning: expect.stringContaining("secondary rate limit exceeded") });
  });

  it("cancelInFlightWorkflowRunsForHeadSha stops at the FIRST failing cancel and never reports a partial success as cancelled", async () => {
    const privateKey = await generatePrivateKeyPem();
    let secondCancelCalled = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=in_progress")) return Response.json({ workflow_runs: [{ id: 44, event: "pull_request", pull_requests: [{ number: 55 }] }, { id: 45, event: "pull_request", pull_requests: [{ number: 55 }] }] });
      if (url.includes("/actions/runs?head_sha=") && url.includes("status=queued")) return Response.json({ workflow_runs: [] });
      if (url.endsWith("/actions/runs/44/cancel") && method === "POST") return new Response(null, { status: 500 });
      if (url.endsWith("/actions/runs/45/cancel") && method === "POST") {
        secondCancelCalled = true;
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });

    const outcome = await cancelInFlightWorkflowRunsForHeadSha(createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }), 123, "owner/repo", "sha-cancel-partial", 55);

    expect(outcome.kind).toBe("error");
    expect(secondCancelCalled).toBe(false); // stopped at the first failure rather than continuing past it
  });

  it("updates an existing Gittensory check run for the same head SHA", async () => {
    const privateKey = await generatePrivateKeyPem();
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        methods.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/access_tokens")) {
          return Response.json({ token: "installation-token" });
        }
        if (url.includes("/commits/abc123/check-runs")) {
          return Response.json({
            total_count: 1,
            check_runs: [{ id: 42, name: "Gittensory" }],
          });
        }
        if (url.includes("/check-runs/42")) {
          const body = JSON.parse(String(init?.body)) as {
            name: string;
            conclusion: string;
            output: { title: string; text: string };
          };
          expect(body.name).toBe("Gittensory Context");
          expect(body.conclusion).toBe("success");
          expect(body.output.title).toBe("Gittensory context checked");
          expect(body.output.text).not.toMatch(
            /reviewability|reward|farming|wallet|hotkey|trust score/i,
          );
          return Response.json({
            id: 42,
            html_url: "https://github.com/checks/42",
          });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-2",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 1,
      headSha: "abc123",
      conclusion: "success",
      severity: "info",
      title: "Gittensory advisory passed",
      summary: "Pull request advisory generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );

    expect(result).toMatchObject({ kind: "published", id: 42 });
    expect(
      methods.some(
        (call) => call.startsWith("PATCH ") && call.includes("/check-runs/42"),
      ),
    ).toBe(true);
  });

  it("returns permission_missing outcome when GitHub returns 403", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/commits/"))
        return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs"))
        return new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 403 },
        );
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-403",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#5",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 5,
      headSha: "def456",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );

    expect(result).toMatchObject({ kind: "permission_missing" });
    expect((result as { kind: string; warning: string }).warning).toMatch(
      /Checks: write/i,
    );
    // The ACTUAL 403 is logged (check_run_post_denied) with repo + status + GitHub's message, so a denied
    // gate-check is diagnosable in Sentry instead of an opaque "permission missing". (#review-403-context)
    expect(
      errSpy.mock.calls.some((c) => {
        const line = String(c[0]);
        return (
          line.includes("check_run_post_denied") &&
          line.includes('"status":403') &&
          line.includes("JSONbored/gittensory") &&
          line.includes("Resource not accessible")
        );
      }),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("reposts a fresh check-run when an existing one was created by a PRIOR App (cross-app 403)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        // An existing run (created by the OLD app) is found on the commit...
        if (url.includes("/commits/") && url.includes("/check-runs"))
          return Response.json({ total_count: 1, check_runs: [{ id: 99 }] });
        // ...PATCHing it 403s because a different app_id created it...
        if (method === "PATCH" && url.includes("/check-runs/"))
          return new Response(
            JSON.stringify({
              message:
                "Invalid app_id 3824093 - check run can only be modified by the GitHub App that created it.",
            }),
            { status: 403 },
          );
        // ...so the engine POSTs a fresh run THIS app owns instead of failing the gate.
        if (method === "POST" && url.includes("/check-runs"))
          return Response.json({ id: 4242 });
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-crossapp",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#7",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 7,
      headSha: "crossapp123",
      conclusion: "neutral",
      severity: "info",
      title: "Gittensory advisory",
      summary: "ok",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );
    // Reposted as a fresh run (NOT permission_missing) — the stale prior-App run is unreachable.
    expect(result).toMatchObject({ kind: "published", id: 4242 });
    expect(
      logSpy.mock.calls.some((c) => {
        const line = String(c[0]);
        return (
          line.includes("check_run_cross_app_repost") &&
          line.includes('"staleCheckRunId":99')
        );
      }),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("isCrossAppCheckRunError detects a prior-App check-run 403, not other errors", () => {
    expect(
      isCrossAppCheckRunError({
        message:
          "Invalid app_id 3824093 - check run can only be modified by the GitHub App that created it.",
      }),
    ).toBe(true);
    expect(
      isCrossAppCheckRunError({
        status: 403,
        message: "Resource not accessible by integration",
      }),
    ).toBe(false);
    expect(isCrossAppCheckRunError({})).toBe(false); // no message
    expect(isCrossAppCheckRunError(null)).toBe(false); // non-object
  });

  it("creates a failing opt-in Gittensory Orb Review Agent check for merge blockers", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: {
      name?: string;
      conclusion?: string;
      output?: { title?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json(
            { id: 88, html_url: "https://github.com/checks/88" },
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdateGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      {
        id: "gate-advisory",
        targetType: "pull_request",
        targetKey: "JSONbored/gittensory#9",
        repoFullName: "JSONbored/gittensory",
        pullNumber: 9,
        headSha: "gate123",
        conclusion: "neutral",
        severity: "warning",
        title: "Gittensory advisory available",
        summary: "1 advisory finding generated.",
        findings: [
          {
            code: "missing_linked_issue",
            title: "No linked issue detected",
            severity: "warning",
            detail: "No closing reference.",
            action: "Link the issue before merge.",
          },
        ],
        generatedAt: "2026-05-22T00:00:00.000Z",
      },
      { linkedIssueGateMode: "block" },
    );

    expect(result).toMatchObject({ kind: "published", id: 88 });
    expect(capturedBody).toMatchObject({
      name: "Gittensory Orb Review Agent",
      conclusion: "failure",
      output: { title: "Gittensory Orb Review Agent: No linked issue detected" },
    });
    expect(capturedBody.output?.text).toContain("Link the issue before merge.");
    expect(capturedBody.output?.text).not.toMatch(
      /reward|wallet|hotkey|trust score|reviewability|farming/i,
    );
  });

  it("creates an in-progress Gate check without a conclusion", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: {
      name?: string;
      status?: string;
      conclusion?: string;
      details_url?: string;
      output?: { title?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({ id: 89 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("pending123"),
    );

    expect(result).toMatchObject({ kind: "published", id: 89 });
    expect(capturedBody).toMatchObject({
      name: "Gittensory Orb Review Agent",
      status: "in_progress",
      output: { title: "Gittensory Orb Review Agent is evaluating" },
    });
    expect(capturedBody).not.toHaveProperty("conclusion");
    // The Gate blocks every author the same on a configured blocker (confirmed status no longer gates the verdict).
    expect(capturedBody.output?.text).toContain("blocks every author");
    // The "Details" link points at the repo's Gittensory maintainer panel, not GitHub's generic check page. (#audit-details-url)
    expect(capturedBody.details_url).toBe(
      "https://gittensory.aethereal.dev/app?view=maintainer&repo=JSONbored%2Fgittensory",
    );
  });

  it("finalizes the legacy pending Gate check when posting the renamed review-agent check", async () => {
    const privateKey = await generatePrivateKeyPem();
    let newCheckBody: { name?: string; status?: string; conclusion?: string } = {};
    let legacyPatchBody: {
      name?: string;
      status?: string;
      conclusion?: string;
      output?: { title?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/legacy-pending/check-runs")) {
          const checkName = new URL(url).searchParams.get("check_name");
          if (checkName === "Gittensory Orb Review Agent")
            return Response.json({ total_count: 0, check_runs: [] });
          if (checkName === "Gittensory Gate")
            return Response.json({
              total_count: 1,
              check_runs: [
                { id: 321, name: "Gittensory Gate", status: "in_progress" },
              ],
            });
        }
        if (url.includes("/check-runs/321") && method === "PATCH") {
          legacyPatchBody = JSON.parse(String(init?.body)) as typeof legacyPatchBody;
          return Response.json({ id: 321 });
        }
        if (url.includes("/check-runs") && method === "POST") {
          newCheckBody = JSON.parse(String(init?.body)) as typeof newCheckBody;
          return Response.json({ id: 89 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("legacy-pending"),
    );

    expect(result).toMatchObject({ kind: "published", id: 89 });
    expect(newCheckBody).toMatchObject({
      name: "Gittensory Orb Review Agent",
      status: "in_progress",
    });
    expect(newCheckBody).not.toHaveProperty("conclusion");
    expect(legacyPatchBody).toMatchObject({
      name: "Gittensory Gate",
      status: "completed",
      conclusion: "neutral",
      output: {
        title:
          "Gittensory Orb Review Agent superseded this legacy check",
      },
    });
    expect(legacyPatchBody.output?.text).toContain(
      "Use Gittensory Orb Review Agent",
    );
  });

  it("leaves an already-completed legacy Gate check alone while posting the renamed review-agent check", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    let newCheckBody: { name?: string; status?: string } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/legacy-completed/check-runs")) {
          const checkName = new URL(url).searchParams.get("check_name");
          if (checkName === "Gittensory Orb Review Agent")
            return Response.json({ total_count: 0, check_runs: [] });
          if (checkName === "Gittensory Gate")
            return Response.json({
              total_count: 1,
              check_runs: [
                { id: 323, name: "Gittensory Gate", status: "completed" },
              ],
            });
        }
        if (url.includes("/check-runs/323"))
          throw new Error("must not patch completed legacy check");
        if (url.includes("/check-runs") && method === "POST") {
          newCheckBody = JSON.parse(String(init?.body)) as typeof newCheckBody;
          return Response.json({ id: 91 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("legacy-completed"),
    );

    expect(result).toMatchObject({ kind: "published", id: 91 });
    expect(newCheckBody).toMatchObject({
      name: "Gittensory Orb Review Agent",
      status: "in_progress",
    });
    expect(calls.some((call) => call.includes("/check-runs/323"))).toBe(false);
  });

  it("still posts the renamed review-agent check when legacy Gate cleanup fails", async () => {
    const privateKey = await generatePrivateKeyPem();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let newCheckBody: { name?: string; status?: string } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/legacy-cleanup-fails/check-runs")) {
          const checkName = new URL(url).searchParams.get("check_name");
          if (checkName === "Gittensory Orb Review Agent")
            return Response.json({ total_count: 0, check_runs: [] });
          if (checkName === "Gittensory Gate")
            return Response.json({
              total_count: 1,
              check_runs: [
                { id: 322, name: "Gittensory Gate", status: "in_progress" },
              ],
            });
        }
        if (url.includes("/check-runs/322") && method === "PATCH")
          return new Response("legacy patch failed", { status: 500 });
        if (url.includes("/check-runs") && method === "POST") {
          newCheckBody = JSON.parse(String(init?.body)) as typeof newCheckBody;
          return Response.json({ id: 90 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    try {
      const result = await createOrUpdatePendingGateCheckRun(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        gateAdvisory("legacy-cleanup-fails"),
      );

      expect(result).toMatchObject({ kind: "published", id: 90 });
      expect(newCheckBody).toMatchObject({
        name: "Gittensory Orb Review Agent",
        status: "in_progress",
      });
      expect(warn.mock.calls.some((call) => String(call[0]).includes("legacy_gate_check_finalize_failed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("omits details_url when the site origin cannot form a URL (#audit-details-url null arm)", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: { details_url?: string } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({ id: 90 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: privateKey,
      PUBLIC_SITE_ORIGIN: "not-a-valid-origin",
    });
    await createOrUpdatePendingGateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      gateAdvisory("pending-no-url"),
    );
    expect(capturedBody).not.toHaveProperty("details_url");
  });

  it("finalizes a known pending Gate check by id without listing check runs first", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    let capturedBody: {
      name?: string;
      status?: string;
      conclusion?: string;
      output?: { title?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/check-runs/456")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({ id: 456 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdateGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("final123"),
      {},
      { checkRunId: 456 },
    );

    expect(result).toEqual({ kind: "published", id: 456 });
    expect(
      calls.some((call) => call.includes("/commits/final123/check-runs")),
    ).toBe(false);
    expect(capturedBody).toMatchObject({
      name: "Gittensory Orb Review Agent",
      status: "completed",
      conclusion: "success",
      output: { title: "Gittensory Orb Review Agent passed" },
    });
  });

  it("publishes the precomputed authoritative gate (surface-lane override) instead of re-deriving (#5)", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: {
      conclusion?: string;
      output?: { title?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({ id: 91 }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    // The advisory is CLEAN (re-deriving via evaluateGateCheck would publish "success"), but the surface lane
    // REJECTED the PR. The published check must reflect the authoritative override, not the generic re-derivation.
    const surfaceGate = {
      enabled: true,
      conclusion: "failure" as const,
      title: "Metagraphed surface review",
      summary: "Surface payload rejected.",
      blockers: [
        {
          code: "surface_lane_reject",
          title: "Surface rejected",
          severity: "critical" as const,
          detail: "Registry payload failed validation.",
        },
      ],
      warnings: [],
    };
    const result = await createOrUpdateGateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      gateAdvisory("surface-sha"),
      {},
      { gate: surfaceGate },
    );

    expect(result).toEqual({ kind: "published", id: 91 });
    expect(capturedBody.conclusion).toBe("failure"); // the surface override, NOT the clean re-derivation
    expect(capturedBody.output?.title).toBe("Metagraphed surface review");
  });

  it("updates an existing pending Gate check without adding a conclusion", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: { status?: string; conclusion?: string } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/pending-existing/check-runs")) {
          return Response.json({
            total_count: 1,
            check_runs: [{ id: 333, name: "Gittensory Orb Review Agent", status: "in_progress" }],
          });
        }
        if (url.includes("/check-runs/333")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({
            id: 333,
            html_url: "https://github.com/checks/333",
          });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("pending-existing"),
    );

    expect(result).toMatchObject({
      kind: "published",
      id: 333,
      html_url: "https://github.com/checks/333",
    });
    expect(capturedBody.status).toBe("in_progress");
    expect(capturedBody).not.toHaveProperty("conclusion");
  });

  it("posts a fresh pending Gate check instead of patching a completed run", async () => {
    const privateKey = await generatePrivateKeyPem();
    const calls: string[] = [];
    let capturedBody: { status?: string; conclusion?: string; output?: { title?: string } } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/pending-after-failure/check-runs")) {
          return Response.json({
            total_count: 1,
            check_runs: [
              {
                id: 444,
                name: "Gittensory Orb Review Agent",
                status: "completed",
                conclusion: "failure",
              },
            ],
          });
        }
        if (url.includes("/check-runs/444"))
          throw new Error("must not patch completed Gate run");
        if (url.includes("/check-runs") && method === "POST") {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json({
            id: 445,
            html_url: "https://github.com/checks/445",
          }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdatePendingGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("pending-after-failure"),
    );

    expect(result).toMatchObject({
      kind: "published",
      id: 445,
      html_url: "https://github.com/checks/445",
    });
    expect(calls.some((call) => call.includes("/check-runs/444"))).toBe(false);
    expect(capturedBody).toMatchObject({
      status: "in_progress",
      output: { title: "Gittensory Orb Review Agent is evaluating" },
    });
    expect(capturedBody).not.toHaveProperty("conclusion");
  });

  it("publishes a skipped Gate check for closed PR races", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: {
      status?: string;
      conclusion?: string;
      output?: { title?: string; summary?: string; text?: string };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/closed123/check-runs"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
          return Response.json(
            { id: 91, html_url: "https://github.com/checks/91" },
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const result = await createOrUpdateSkippedGateCheckRun(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
      "JSONbored/gittensory",
      gateAdvisory("closed123"),
      "Merged before Gittensory finished.",
    );

    expect(result).toMatchObject({ kind: "published", id: 91 });
    expect(capturedBody).toMatchObject({
      status: "completed",
      conclusion: "skipped",
      output: {
        title: "Gittensory Orb Review Agent skipped",
        summary: "Merged before Gittensory finished.",
      },
    });
    expect(capturedBody.output?.text).toContain(
      "does not post late first comments",
    );
  });

  it("reposts a known check-run id when the old run belongs to a prior App", async () => {
    const privateKey = await generatePrivateKeyPem();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(`${method} ${url}`);
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (method === "PATCH" && url.includes("/check-runs/456"))
          return new Response(
            JSON.stringify({
              message:
                "Invalid app_id 3824093 - check run can only be modified by the GitHub App that created it.",
            }),
            { status: 403 },
          );
        if (method === "POST" && url.includes("/check-runs"))
          return Response.json({ id: 457, html_url: "https://github.com/checks/457" }, { status: 201 });
        return new Response("not found", { status: 404 });
      },
    );

    try {
      const result = await createOrUpdateGateCheckRun(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
        "JSONbored/gittensory",
        gateAdvisory("cross-app-known-id"),
        {},
        { checkRunId: 456 },
      );

      expect(result).toMatchObject({ kind: "published", id: 457 });
      expect(
        calls.some((call) =>
          call.includes("/commits/cross-app-known-id/check-runs"),
        ),
      ).toBe(false);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes('"staleCheckRunId":456'),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("publishes Context check annotations on changed files while Gate stays text-only", async () => {
    const privateKey = await generatePrivateKeyPem();
    let contextBody: {
      name?: string;
      output?: { annotations?: Array<{ path: string; title: string }> };
    } = {};
    let gateBody: {
      name?: string;
      output?: { annotations?: Array<{ path: string; title: string }> };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          const body = JSON.parse(String(init?.body)) as {
            name?: string;
            output?: { annotations?: Array<{ path: string; title: string }> };
          };
          if (body.name === "Gittensory Context") contextBody = body;
          if (body.name === "Gittensory Orb Review Agent") gateBody = body;
          return Response.json(
            { id: body.name === "Gittensory Orb Review Agent" ? 90 : 77 },
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-annot",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#9",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 9,
      headSha: "bbb999",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
      "standard",
      {
        pullNumber: 9,
        files: [
          {
            repoFullName: "JSONbored/gittensory",
            pullNumber: 9,
            path: "src/api/routes.ts",
            additions: 4,
            deletions: 0,
            changes: 4,
            payload: {},
          },
        ],
        collisions: {
          repoFullName: "JSONbored/gittensory",
          generatedAt: "2026-06-10T00:00:00.000Z",
          summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
          clusters: [],
        },
      },
    );
    await createOrUpdateGateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );

    expect(contextBody.output?.annotations?.[0]).toMatchObject({
      path: "src/api/routes.ts",
      title: "Missing test evidence",
    });
    expect(gateBody.output?.annotations).toBeUndefined();
  });

  it("omits annotations when updating an existing Context check run", async () => {
    const privateKey = await generatePrivateKeyPem();
    let patchedBody: {
      output?: {
        annotations?: Array<{ path: string; title: string }>;
        text?: string;
      };
    } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({
            total_count: 1,
            check_runs: [{ id: 77, name: "Gittensory Context" }],
          });
        if (url.includes("/check-runs/77")) {
          patchedBody = JSON.parse(String(init?.body)) as {
            output?: {
              annotations?: Array<{ path: string; title: string }>;
              text?: string;
            };
          };
          return Response.json({ id: 77 }, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-annot-update",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#9",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 9,
      headSha: "bbb999",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
      "standard",
      {
        pullNumber: 9,
        files: [
          {
            repoFullName: "JSONbored/gittensory",
            pullNumber: 9,
            path: "src/api/routes.ts",
            additions: 4,
            deletions: 0,
            changes: 4,
            payload: {},
          },
        ],
        collisions: {
          repoFullName: "JSONbored/gittensory",
          generatedAt: "2026-06-10T00:00:00.000Z",
          summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 },
          clusters: [],
        },
      },
    );

    expect(patchedBody.output?.text).toBe(
      "No detailed findings are published in check runs.",
    );
    expect(patchedBody.output?.annotations).toBeUndefined();
  });

  it("publishes check run with standard detail level and includes public-safe finding text", async () => {
    const privateKey = await generatePrivateKeyPem();
    let capturedBody: { output?: { text?: string } } = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens"))
          return Response.json({ token: "installation-token" });
        if (url.includes("/commits/"))
          return Response.json({ total_count: 0, check_runs: [] });
        if (url.includes("/check-runs")) {
          capturedBody = JSON.parse(String(init?.body)) as {
            output?: { text?: string };
          };
          return Response.json(
            { id: 77, html_url: "https://github.com/checks/77" },
            { status: 201 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-std",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#9",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 9,
      headSha: "bbb999",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [
        {
          code: "missing_linked_issue",
          title: "No linked issue detected",
          severity: "warning",
          detail: "No closing reference.",
          publicText: "Public PR context is available for maintainer review.",
        },
      ],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
      "standard",
    );

    expect(result).toMatchObject({ kind: "published", id: 77 });
    expect(capturedBody.output?.text).toMatch(
      /⚠️ Public PR context is available/,
    );
    expect(capturedBody.output?.text).not.toMatch(
      /No linked issue|reward|wallet|hotkey|trust score|reviewability|farming/i,
    );
  });

  it("returns permission_missing for message-based 422 permission errors", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/commits/"))
        return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 422 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-422",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#6",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 6,
      headSha: "fff111",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    const result = await createOrUpdateCheckRun(
      env,
      123,
      "JSONbored/gittensory",
      advisory,
    );
    expect(result).toMatchObject({ kind: "permission_missing" });
  });

  it("rethrows non-permission errors from the check-run API", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/commits/"))
        return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs"))
        return new Response("internal server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-500",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#7",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 7,
      headSha: "aaa000",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    await expect(
      createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory),
    ).rejects.toThrow();
  });

  it("rethrows non-object check-run errors", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/commits/"))
        return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/check-runs")) throw "network interrupted";
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const advisory: Advisory = {
      id: "advisory-string-error",
      targetType: "pull_request",
      targetKey: "JSONbored/gittensory#8",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 8,
      headSha: "string-error",
      conclusion: "neutral",
      severity: "warning",
      title: "Gittensory advisory available",
      summary: "1 advisory finding generated.",
      findings: [],
      generatedAt: "2026-05-22T00:00:00.000Z",
    };

    await expect(
      createOrUpdateCheckRun(env, 123, "JSONbored/gittensory", advisory),
    ).rejects.toMatchObject({ cause: "network interrupted" });
  });

  it("skips check creation when no head SHA is available", async () => {
    const result = await createOrUpdateCheckRun(
      createTestEnv(),
      123,
      "JSONbored/gittensory",
      {
        id: "advisory-3",
        targetType: "pull_request",
        targetKey: "JSONbored/gittensory#1",
        repoFullName: "JSONbored/gittensory",
        pullNumber: 1,
        conclusion: "success",
        severity: "info",
        title: "Gittensory advisory passed",
        summary: "Pull request advisory generated.",
        findings: [],
        generatedAt: "2026-05-22T00:00:00.000Z",
      },
    );

    expect(result).toBeNull();
  });

  it("rejects invalid repo names and missing app credentials", async () => {
    await expect(
      createOrUpdateCheckRun(createTestEnv(), 123, "invalid", {
        id: "advisory-4",
        targetType: "pull_request",
        targetKey: "invalid#1",
        repoFullName: "invalid",
        pullNumber: 1,
        headSha: "abc123",
        conclusion: "success",
        severity: "info",
        title: "Gittensory advisory passed",
        summary: "Pull request advisory generated.",
        findings: [],
        generatedAt: "2026-05-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/Invalid repository full name/);

    await expect(
      createInstallationToken(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: "" }),
        123,
      ),
    ).rejects.toThrow(/not configured/);
    expect(
      getInstallationId({ action: "created", installation: { id: 123 } }),
    ).toBe(123);
    expect(getInstallationId({ action: "created" })).toBeNull();
  });

  it("surfaces GitHub token response failures", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal(
      "fetch",
      async () => new Response("bad credentials", { status: 401 }),
    );
    await expect(
      createInstallationToken(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
      ),
    ).rejects.toThrow(/Failed to create GitHub installation token/);

    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(
      createInstallationToken(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
      ),
    ).rejects.toThrow(/did not include a token/);
  });

  it("fetches live GitHub App installation metadata", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json({
          id: 123,
          account: { login: "JSONbored", id: 1, type: "User" },
          target_type: "User",
          repository_selection: "selected",
          permissions: {
            checks: "write",
            metadata: "read",
            pull_requests: "read",
            issues: "write",
          },
          events: ["issues", "pull_request", "repository"],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const installation = await getAppInstallation(
      createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
      123,
    );

    expect(installation).toMatchObject({
      id: 123,
      account: { login: "JSONbored" },
      permissions: { checks: "write" },
      events: expect.arrayContaining(["pull_request"]),
    });
  });

  it("INVARIANT (#4506): getAppInstallation's call is recorded into the shared rate-limit observation store", async () => {
    const privateKey = await generatePrivateKeyPem();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/app/installations/123")) {
        return Response.json(
          { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] },
          { headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-reset": "1779976046" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await getAppInstallation(env, 123);

    // Unlike a bare fetch, this is now visible to shouldWaitForGitHubRateLimit's admission reads -- before #4506,
    // this call passed no rate-limit-admission option at all, so it never reached recordGitHubRateLimitObservation.
    expect(await listLatestGitHubRateLimitObservations(env)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/app/installations/123", statusCode: 200, remaining: 4321, admissionKey: "installation:123" })]),
    );
  });

  it("surfaces live GitHub App installation fetch failures", async () => {
    const privateKey = await generatePrivateKeyPem();
    vi.stubGlobal(
      "fetch",
      async () => new Response("installation missing", { status: 404 }),
    );
    await expect(
      getAppInstallation(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
      ),
    ).rejects.toThrow(/Failed to fetch GitHub App installation/);

    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(
      getAppInstallation(
        createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey }),
        123,
      ),
    ).rejects.toThrow(/did not include an id/);
  });
});

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function gateAdvisory(headSha: string): Advisory {
  return {
    id: `advisory-${headSha}`,
    targetType: "pull_request",
    targetKey: "JSONbored/gittensory#10",
    repoFullName: "JSONbored/gittensory",
    pullNumber: 10,
    headSha,
    conclusion: "success",
    severity: "info",
    title: "Gittensory advisory passed",
    summary: "Pull request advisory generated.",
    findings: [],
    generatedAt: "2026-05-22T00:00:00.000Z",
  };
}

describe("isForeignAppInstallation (#selfhost-app-id)", () => {
  it("returns true only on a positive numeric app_id mismatch", () => {
    expect(isForeignAppInstallation("12345", 99999)).toBe(true);
  });

  it("returns false when this backend's own app id and the installation's match", () => {
    expect(isForeignAppInstallation("12345", 12345)).toBe(false);
  });

  it("FAILS OPEN (false) when the installation app_id is unknown — null or undefined", () => {
    expect(isForeignAppInstallation("12345", null)).toBe(false);
    expect(isForeignAppInstallation("12345", undefined)).toBe(false);
  });

  it("FAILS OPEN (false) when this backend has no / an unparseable own app id", () => {
    expect(isForeignAppInstallation(undefined, 99999)).toBe(false);
    expect(isForeignAppInstallation("", 99999)).toBe(false);
    expect(isForeignAppInstallation("not-a-number", 99999)).toBe(false);
  });
});

describe("self-host Redis token store + GitHub GET response cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses an injected external token store (Redis on the self-host) instead of the in-isolate Map", async () => {
    const privateKey = await generatePrivateKeyPem();
    const store = new Map<number, { token: string; expiresAtMs: number }>();
    setInstallationTokenStore({
      get: async (id) => store.get(id) ?? null,
      set: async (id, v) => void store.set(id, v),
    });
    let mints = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/access_tokens")) {
        mints += 1;
        return Response.json({
          token: `ext-token-${mints}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const first = await createInstallationToken(env, 321);
    const second = await createInstallationToken(env, 321);

    expect(first).toBe("ext-token-1");
    expect(second).toBe("ext-token-1"); // second served from the external store, not re-minted
    expect(mints).toBe(1);
    expect(store.has(321)).toBe(true); // written to the external store, not the in-isolate Map
  });

  it("isCacheableGithubUrl: caches safe GitHub GETs but not sensitive endpoints", () => {
    expect(
      isCacheableGithubUrl("https://api.github.com/repos/o/r"),
    ).toBe(true);
    expect(isCacheableGithubUrl("https://api.github.com/repos/o/r/pulls/1")).toBe(false);
    expect(isCacheableGithubUrl("https://api.github.com/repos/o/r/pulls/1/files")).toBe(false);
    expect(isCacheableGithubUrl("https://api.github.com/repos/o/r/issues/1/labels")).toBe(false);
    expect(isCacheableGithubUrl("https://api.github.com/repos/o/r/issues/1/comments")).toBe(false);
    expect(
      isCacheableGithubUrl(
        "https://api.github.com/app/installations/1/access_tokens",
      ),
    ).toBe(false);
    expect(isCacheableGithubUrl("https://api.github.com/rate_limit")).toBe(
      false,
    );
    expect(
      isCacheableGithubUrl(
        "https://api.github.com/repos/o/r/collaborators/maintainer/permission",
      ),
    ).toBe(false);
    expect(
      isCacheableGithubUrl(
        "https://api.github.com/repos/o/r/collaborators/maintainer/permission?ref=live",
      ),
    ).toBe(false);
    expect(isCacheableGithubUrl("https://example.com/x")).toBe(false);
  });

  it("does not serve repository collaborator permissions from the shared response cache", async () => {
    const privateKey = await generatePrivateKeyPem();
    const store = new Map<
      string,
      { status: number; body: string; contentType: string }
    >();
    setGitHubResponseCache({
      get: async (u) => store.get(u) ?? null,
      set: async (u, v) => void store.set(u, v),
    });
    let permissionFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.endsWith("/repos/o/r/collaborators/maintainer/permission")) {
        permissionFetches += 1;
        return Response.json({ permission: "write" });
      }
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    await expect(
      getRepositoryCollaboratorPermission(env, 123, "o/r", "maintainer"),
    ).resolves.toBe("write");
    await expect(
      getRepositoryCollaboratorPermission(env, 123, "o/r", "maintainer"),
    ).resolves.toBe("write");

    expect(permissionFetches).toBe(2);
    expect(store.size).toBe(0);
  });

  it("serves a cached GitHub GET on the second call and skips the network", async () => {
    const privateKey = await generatePrivateKeyPem();
    const store = new Map<
      string,
      { status: number; body: string; contentType: string }
    >();
    setGitHubResponseCache({
      get: async (u) => store.get(u) ?? null,
      set: async (u, v) => void store.set(u, v),
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/app/installations/42")) {
        getFetches += 1;
        return Response.json({ id: 42, account: { login: "JSONbored" } });
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    const a = await getAppInstallation(env, 42);
    const b = await getAppInstallation(env, 42);
    expect(a.id).toBe(42);
    expect(b.id).toBe(42);
    expect(getFetches).toBe(1); // second call served from the response cache
    expect([...store.keys()].some((key) => key.includes("https://api.github.com/app/installations/42"))).toBe(true);
    expect([...store.keys()].some((key) => key.includes("Bearer "))).toBe(false);
  });

  it("reuses the App JWT within its window so metadata reads keep cache-hitting despite rotation (#1940)", async () => {
    const privateKey = await generatePrivateKeyPem();
    const rotatedKey = await generatePrivateKeyPem();
    vi.useFakeTimers();
    try {
      const store = new Map<string, { status: number; body: string; contentType: string }>();
      setGitHubResponseCache({ get: async (u) => store.get(u) ?? null, set: async (u, v) => void store.set(u, v) });
      let fetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/app/installations/42")) {
          fetches += 1;
          return Response.json({ id: 42, account: { login: "JSONbored" } });
        }
        return new Response("not found", { status: 404 });
      });
      const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
      await getAppInstallation(env, 42); // cache empty → mint JWT → network fetch
      vi.advanceTimersByTime(90_000); // 90s later: a freshly-minted JWT would rotate (new iat) and MISS the cache
      await getAppInstallation(env, 42);
      expect(fetches).toBe(1); // JWT reused → stable auth-scoped key → served from the response cache

      // A same-App private-KEY rotation must re-mint immediately — never serve a JWT signed by the old, now-revoked
      // key (which would fail every App-level read once GitHub rejects the old key). Still inside the reuse window.
      const rotated = createTestEnv({ GITHUB_APP_PRIVATE_KEY: rotatedKey }); // same App id, new key
      await getAppInstallation(rotated, 42);
      expect(fetches).toBe(2); // key changed → cache invalid → re-mint → new auth key → cache miss → network fetch

      vi.advanceTimersByTime(9 * 60_000); // past the reuse window → the JWT is re-minted
      await getAppInstallation(rotated, 42);
      expect(fetches).toBe(3);

      // A different App id never reuses another App's cached JWT.
      const otherApp = createTestEnv({ GITHUB_APP_PRIVATE_KEY: rotatedKey, GITHUB_APP_ID: "999999" });
      await getAppInstallation(otherApp, 42);
      expect(fetches).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a per-App JWT so alternating App identities do not evict each other (#1940)", async () => {
    const keyA = await generatePrivateKeyPem();
    const keyB = await generatePrivateKeyPem();
    vi.useFakeTimers();
    try {
      const store = new Map<string, { status: number; body: string; contentType: string }>();
      setGitHubResponseCache({ get: async (u) => store.get(u) ?? null, set: async (u, v) => void store.set(u, v) });
      let fetches = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/app/installations/7")) {
          fetches += 1;
          return Response.json({ id: 7, account: { login: "JSONbored" } });
        }
        return new Response("not found", { status: 404 });
      });
      const appA = createTestEnv({ GITHUB_APP_PRIVATE_KEY: keyA }); // App 3824093
      const appB = createTestEnv({ GITHUB_APP_PRIVATE_KEY: keyB, GITHUB_APP_ID: "555" });
      await getAppInstallation(appA, 7); // mint A → fetch (caches /7 under A's JWT)
      await getAppInstallation(appB, 7); // mint B → fetch
      vi.advanceTimersByTime(30_000); // a re-mint here would rotate the JWT (new iat) and miss the cache
      await getAppInstallation(appA, 7); // A still cached in the Map → reuse A's JWT → response-cache HIT → no fetch
      expect(fetches).toBe(2); // A was NOT evicted by B — a single-entry cache would re-mint A → cache miss → fetch
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a non-200 GitHub GET", async () => {
    const privateKey = await generatePrivateKeyPem();
    const store = new Map<
      string,
      { status: number; body: string; contentType: string }
    >();
    setGitHubResponseCache({
      get: async (u) => store.get(u) ?? null,
      set: async (u, v) => void store.set(u, v),
    });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    await expect(getAppInstallation(env, 99)).rejects.toThrow();
    expect(store.size).toBe(0); // non-200 not cached
  });
});

describe("GitHub rate-limit handling (#ratelimit-resilience)", () => {
  describe("isRateLimitedResponse", () => {
    it("is false for a 200 and for a non-rate 403 (real permission error)", async () => {
      expect(await isRateLimitedResponse(new Response("ok", { status: 200 }))).toBe(false);
      expect(
        await isRateLimitedResponse(
          new Response("Resource not accessible by integration", { status: 403 }),
        ),
      ).toBe(false);
    });
    it("detects a primary limit (x-ratelimit-remaining:0) and a Retry-After (secondary/429)", async () => {
      expect(
        await isRateLimitedResponse(
          new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
        ),
      ).toBe(true);
      expect(
        await isRateLimitedResponse(
          new Response("", { status: 429, headers: { "retry-after": "1" } }),
        ),
      ).toBe(true);
    });
    it("detects a secondary limit from the body when headers are absent", async () => {
      expect(
        await isRateLimitedResponse(
          new Response("You have exceeded a secondary rate limit", { status: 403 }),
        ),
      ).toBe(true);
    });
  });

  describe("rateLimitRetryMs", () => {
    it("honors a valid Retry-After (seconds), capped, including 0", () => {
      expect(rateLimitRetryMs(new Response("", { headers: { "retry-after": "2" } }), 0)).toBe(2000);
      expect(rateLimitRetryMs(new Response("", { headers: { "retry-after": "9999" } }), 0)).toBe(8000);
      expect(rateLimitRetryMs(new Response("", { headers: { "retry-after": "0" } }), 0)).toBe(0);
    });
    it("falls back to exponential backoff when Retry-After is absent or invalid", () => {
      expect(rateLimitRetryMs(new Response("", {}), 2)).toBe(2000); // 500 * 2^2, no header
      expect(rateLimitRetryMs(new Response("", { headers: { "retry-after": "soon" } }), 0)).toBe(500); // invalid → 500 * 2^0
    });
  });

  describe("isCheckRunPermissionError — a rate-limit 403 is NOT a permission gap", () => {
    it("classifies a genuine permission error as permission_missing", () => {
      expect(isCheckRunPermissionError({ status: 403, message: "nope" })).toBe(true);
      expect(
        isCheckRunPermissionError({ status: 404, message: "Resource not accessible by integration" }),
      ).toBe(true);
    });
    it("does NOT classify a rate-limit 403/429 as permission_missing", () => {
      expect(
        isCheckRunPermissionError({ status: 403, response: { headers: { "retry-after": "30" } } }),
      ).toBe(false);
      expect(
        isCheckRunPermissionError({ status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } }),
      ).toBe(false);
      expect(
        isCheckRunPermissionError({ status: 429, message: "You have exceeded a secondary rate limit" }),
      ).toBe(false);
    });
    it("is false for a non-object and for a non-permission, non-rate error", () => {
      expect(isCheckRunPermissionError(null)).toBe(false);
      expect(isCheckRunPermissionError({ status: 500, message: "boom" })).toBe(false);
    });
  });

  it("timeoutFetch retries a transient rate-limit, then succeeds (via the token mint)", async () => {
    const privateKey = await generatePrivateKeyPem();
    clearInstallationTokenCacheForTest();
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls += 1;
        if (calls === 1)
          return new Response("secondary rate limit", {
            status: 403,
            headers: { "retry-after": "0" }, // 0 → instant retry (fast test)
          });
        return Response.json({
          token: "tok-after-retry",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    expect(await createInstallationToken(env, 5151)).toBe("tok-after-retry");
    expect(calls).toBe(2); // one rate-limited attempt + one success
  });

  it("timeoutFetch gives up after the retry budget so a sustained limit surfaces (→ queue retry)", async () => {
    const privateKey = await generatePrivateKeyPem();
    clearInstallationTokenCacheForTest();
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) {
        calls += 1;
        return new Response("secondary rate limit", {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey });
    await expect(createInstallationToken(env, 5252)).rejects.toThrow();
    expect(calls).toBe(4); // initial + GITHUB_RATE_LIMIT_MAX_RETRIES (3)
  });
});
