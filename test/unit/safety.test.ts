import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import {
  persistRegistrySnapshot,
} from "../../src/registry/sync";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import {
  upsertOfficialMinerDetection,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// Drives the LOOPOVER_REVIEW_SAFETY secrets-scan WIRING through the live review finalize path
// (processGitHubWebhook → maybePublishPrPublicSurface → `await maybeAddSecretLeakFinding(...)` at the gate
// build). The helper itself is unit-tested elsewhere; here we prove the flag-ON call site appends a critical
// `secret_leak` blocker that FAILS the finalized gate end-to-end, and that flag-OFF is byte-identical.

// A leaked GitHub token in the diff so scanForSecrets fires; the gate treats `secret_leak` as a hard blocker.
const LEAKED_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// A self-signed RSA PEM so the GitHub App can mint an installation token (gate check-run posting).
async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const b64 = Buffer.from(pkcs8 as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

// A confirmed-miner snapshot. The author confirmation no longer changes whether the gate can block
// (#gate-nonconfirmed); this just stands up a representative confirmed author so the flag-ON safety blocker's
// FAILURE is observable through the finalized conclusion.
function safetyMinerSnapshot(login: string) {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: login,
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: { pullRequests: 3, mergedPullRequests: 2, openPullRequests: 1, closedPullRequests: 0, openIssues: 0, closedIssues: 0, solvedIssues: 0, validSolvedIssues: 0 },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

// Stand up a gate-enabled repo with the SLOP gate on so `gateFiles` is loaded ONCE and shared into
// maybeAddSecretLeakFinding (exercising the `args.files ?? …` reuse side, not the lazy load).
async function seedGateEnabledRepo(env: Env): Promise<void> {
  await persistRegistrySnapshot(
    env,
    normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
  );
  await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
  await upsertRepositorySettings(env, {
    repoFullName: "JSONbored/gittensory",
    commentMode: "off",
    publicSurface: "off",
    autoLabelEnabled: false,
    checkRunMode: "off",
    reviewCheckMode: "required",
    slopGateMode: "advisory", // turns the shared gateFiles load on so the reuse branch is hit
  });
  await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: safetyMinerSnapshot("contributor") }, 60_000);
}

// Seed the PR's changed file carrying the leaked token so buildAiReviewDiff(files) has the secret to find.
async function seedLeakedSecretFile(env: Env): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind("JSONbored/gittensory", 42, "src/config.ts", "modified", 1, 0, 1, JSON.stringify({ patch: `@@\n+const token = "${LEAKED_TOKEN}";` }))
    .run();
}

// Capture the FINALIZED gate conclusion published to the GitHub check-runs PATCH so the test reads the gate's
// real verdict (not an internal value): the secret_leak blocker should drive it to "failure" flag-ON.
function stubFinalizeFetch(seen: { conclusion?: string | undefined }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url === "https://api.gittensor.io/miners") return Response.json([{ uid: 7, githubUsername: "contributor", githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }]);
    if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
    if (/\/pulls\/42(?:\?|$)/.test(url)) return Response.json({ number: 42, state: "open", head: { sha: "gate123" } });
    if (url.includes("/check-runs") && method === "GET") return Response.json({ total_count: 0, check_runs: [] });
    if (url.includes("/check-runs") && method === "POST") return Response.json({ id: 900 }, { status: 201 });
    if (url.includes("/check-runs/900") && method === "PATCH") {
      seen.conclusion = (JSON.parse(String(init?.body ?? "{}")) as { conclusion?: string | undefined }).conclusion;
      return Response.json({ id: 900 });
    }
    return new Response("not found", { status: 404 });
  });
}

function prWebhook(deliveryId: string) {
  return {
    type: "github-webhook" as const,
    deliveryId,
    eventName: "pull_request",
    payload: {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      pull_request: { number: 42, title: "Add config", state: "open", user: { login: "contributor" }, head: { sha: "gate123" }, labels: [], body: "Adds a token." },
    },
  };
}

describe("LOOPOVER_REVIEW_SAFETY secrets-scan wired into the review FINALIZE path (processors.ts call site)", () => {
  it("FLAG-ON: a leaked secret in the PR's changed files FAILS the finalized gate (secret_leak blocker appended before evaluateGateCheck)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_SAFETY: "true", GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedGateEnabledRepo(env);
    await seedLeakedSecretFile(env);
    const seen: { conclusion?: string | undefined } = {};
    stubFinalizeFetch(seen);
    try {
      await processJob(env, prWebhook("safety-finalize-on"));
    } finally {
      vi.unstubAllGlobals();
    }
    // The flag-ON call site appended the critical secret_leak finding → the gate hard-blocks.
    expect(seen.conclusion).toBe("failure");
  });

  it("FLAG-OFF: a leaked secret STILL fails the gate — the concrete-credential block is unconditional (#audit-3.4)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_SAFETY: "false", GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedGateEnabledRepo(env);
    await seedLeakedSecretFile(env);
    const seen: { conclusion?: string | undefined } = {};
    stubFinalizeFetch(seen);
    try {
      await processJob(env, prWebhook("safety-finalize-off"));
    } finally {
      vi.unstubAllGlobals();
    }
    // A real-format committed credential is a leak on any repo, so the secret_leak hard block fires regardless
    // of LOOPOVER_REVIEW_SAFETY (only the prompt-injection defang / AI review remain flag-gated).
    expect(seen.conclusion).toBe("failure");
  });

  it("UNSET (default): a leaked secret also fails the gate — the secret-leak block does not depend on the flag", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() }); // LOOPOVER_REVIEW_SAFETY unset
    await seedGateEnabledRepo(env);
    await seedLeakedSecretFile(env);
    const seen: { conclusion?: string | undefined } = {};
    stubFinalizeFetch(seen);
    try {
      await processJob(env, prWebhook("safety-finalize-unset"));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen.conclusion).toBe("failure");
  });
});
