import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
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
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import {
  GITTENSORY_NATIVE_SOURCE,
  computeParityReadiness,
  isParityAuditEnabled,
  nativeGateActionFromConclusion,
  neutralHoldReasonCode,
  recordNativeGateDecision,
} from "../../src/review/parity-wire";
import type { AdvisoryFinding } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// ── Direct D1 helpers over the real migrated schema (0049 review_audit) ──────────────────────────────────────

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

// Seed an authoritative ('reviewbot') gate_decision row directly — this is what reviewbot's deploy-time dual-run
// writes; here we stand it in so a PAIR exists for the parity self-join.
async function seedReviewbotDecision(env: Env, project: string, pr: number, headSha: string, decision: string, summary: string): Promise<void> {
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, 'gate_decision', ?, 'reviewbot', ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(`gate:reviewbot:${project}#${pr}@${headSha}`, project, `${project}#${pr}`, decision, headSha, summary)
    .run();
}

// ── isParityAuditEnabled — default OFF, truthy convention ────────────────────────────────────────────────────

describe("isParityAuditEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isParityAuditEnabled({ GITTENSORY_REVIEW_PARITY_AUDIT: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isParityAuditEnabled({ GITTENSORY_REVIEW_PARITY_AUDIT: on })).toBe(true);
  });
});

// ── nativeGateActionFromConclusion — gittensory conclusion → comparable GateAction (pure) ────────────────────

describe("nativeGateActionFromConclusion — gittensory gate conclusion → parity GateAction", () => {
  it("maps success → merge, failure/action_required/neutral → hold (gittensory never closes), skipped → null", () => {
    expect(nativeGateActionFromConclusion("success")).toBe("merge");
    expect(nativeGateActionFromConclusion("failure")).toBe("hold");
    expect(nativeGateActionFromConclusion("action_required")).toBe("hold");
    // #terminal-outcome-audit: neutral is a REAL "hold this PR for a human" decision (guardrail/size/manifest-
    // blocked/ai-inconclusive), not "no decision was made" -- recording it is what lets an operator see holds
    // without hand-querying review_audit for a hold class the parity recorder used to silently discard.
    expect(nativeGateActionFromConclusion("neutral")).toBe("hold");
    // skipped is genuinely different: the gate was never evaluated at all (e.g. the repo hasn't finished
    // syncing), so there is no decision, comparable or otherwise, to record.
    expect(nativeGateActionFromConclusion("skipped")).toBeNull();
  });
});

// ── neutralHoldReasonCode — bounded reason-class for a neutral hold (pure) ───────────────────────────────────

describe("neutralHoldReasonCode — bounded hold-reason class for a neutral gate evaluation", () => {
  const finding = (code: string): AdvisoryFinding => ({ code, severity: "warning", title: "t", detail: "d" });

  it("returns null for a non-neutral conclusion, regardless of warnings", () => {
    expect(neutralHoldReasonCode({ conclusion: "success", warnings: [finding("guardrail_hold")] })).toBeNull();
    expect(neutralHoldReasonCode({ conclusion: "failure", warnings: [finding("guardrail_hold")] })).toBeNull();
    expect(neutralHoldReasonCode({ conclusion: "skipped", warnings: [] })).toBeNull();
  });

  it("returns the recognized code for each known neutral-hold class (guardrail, size, ai-inconclusive, sync-state)", () => {
    for (const code of ["guardrail_hold", "oversized_pr", "ai_review_inconclusive", "repo_not_registered", "repo_not_seen", "pr_not_cached", "pre_merge_check_unresolved", "cla_check_unresolved"]) {
      expect(neutralHoldReasonCode({ conclusion: "neutral", warnings: [finding(code)] })).toBe(code);
    }
  });

  it("returns null (fail-safe fallback) when neutral but no recognized code is present in warnings", () => {
    expect(neutralHoldReasonCode({ conclusion: "neutral", warnings: [finding("readiness_score_below_threshold")] })).toBeNull();
    expect(neutralHoldReasonCode({ conclusion: "neutral", warnings: [] })).toBeNull();
  });

  it("picks the first recognized code by priority order when multiple hold findings are present (oversized_pr before guardrail_hold)", () => {
    expect(neutralHoldReasonCode({ conclusion: "neutral", warnings: [finding("guardrail_hold"), finding("oversized_pr")] })).toBe("oversized_pr");
  });
});

// ── Migration 0049 round-trip + flag-gated recording ─────────────────────────────────────────────────────────

describe("recordNativeGateDecision — flag-gated SHADOW recording into review_audit (0049 round-trip)", () => {
  it("flag-ON records ONE gittensory-native gate_decision row (migration applies; round-trips via TestD1Database)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });

    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      project: "owner/repo",
      target_id: "owner/repo#7",
      event_type: "gate_decision",
      decision: "merge", // success → merge
      source: GITTENSORY_NATIVE_SOURCE,
      head_sha: "abc123",
      summary: "all_clear",
    });
    expect(typeof rows[0]!.created_at).toBe("string");
  });

  it("a re-run at the SAME commit REPLACES the prior decision (latest finalize wins, no duplicate)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure", reasonCode: "slop_risk" });

    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows.length).toBe(1); // same (source, project, pr, sha) → one row
    expect(rows[0]).toMatchObject({ decision: "hold", summary: "slop_risk" }); // failure → hold, latest wins
  });

  it("a new commit gets its OWN row", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "sha1", conclusion: "success" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "sha2", conclusion: "failure" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(2);
  });

  it("does NOT record a genuinely non-comparable conclusion (skipped) or a decision with no head_sha", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 2, headSha: "sha", conclusion: "skipped" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 3, headSha: null, conclusion: "success" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(0);
  });

  // #terminal-outcome-audit: neutral (a guardrail/size/manifest-blocked/ai-inconclusive hold) now records as a
  // comparable 'hold' row, same as failure -- this is the fix for the class of hold that used to vanish
  // silently (nativeGateActionFromConclusion previously mapped neutral to null, same as skipped).
  it("records a neutral conclusion as a 'hold' row (the fix for a previously-silent hold class)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 1, headSha: "sha", conclusion: "neutral", reasonCode: "guardrail_hold" });
    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "hold", summary: "guardrail_hold" });
  });

  it("flag-OFF records NOTHING on the CLOUD WORKER — no D1 write (byte-identical review path)", async () => {
    const env = createTestEnv(); // flag unset → OFF
    delete env.SELFHOST_TRANSIENT_CACHE; // simulate the cloud worker (no self-host binding)
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });
    expect((await rawAll(env, "SELECT * FROM review_audit")).length).toBe(0);
    // ...and explicitly false-valued flags are OFF too.
    const envFalse = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "false" });
    delete envFalse.SELFHOST_TRANSIENT_CACHE;
    await recordNativeGateDecision(envFalse, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure" });
    expect((await rawAll(envFalse, "SELECT * FROM review_audit")).length).toBe(0);
  });

  it("SELF-HOSTED instances ALWAYS record, regardless of the flag (#orb-telemetry-gate-decision-gap)", async () => {
    // SELFHOST_TRANSIENT_CACHE present (createTestEnv's default) === a self-hosted instance. The flag stays
    // unset/false — exactly the state of every self-hosted instance in production today (the flag has never
    // been documented as something to enable for self-host) — yet the row must still be written, or
    // exportOrbBatch's FLEET_QUERY INNER JOIN against pr_outcome permanently finds nothing to export.
    const env = createTestEnv(); // flag unset → OFF, but SELFHOST_TRANSIENT_CACHE present → self-hosted
    await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "success", reasonCode: "all_clear" });
    const rows = await rawAll(env, "SELECT * FROM review_audit");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: "merge", source: GITTENSORY_NATIVE_SOURCE, summary: "all_clear" });

    // ...and an explicit "false" flag value doesn't override the self-host signal either.
    const envFalse = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "false" });
    await recordNativeGateDecision(envFalse, { project: "owner/repo", pullNumber: 8, headSha: "def456", conclusion: "failure", reasonCode: "slop_risk" });
    const falseRows = await rawAll(envFalse, "SELECT * FROM review_audit");
    expect(falseRows.length).toBe(1);
    expect(falseRows[0]).toMatchObject({ decision: "hold", source: GITTENSORY_NATIVE_SOURCE, summary: "slop_risk" });
  });

  it("fails safe: a D1 write error is swallowed + logged (telemetry never breaks finalization)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    // Poison the audit INSERT so .run() rejects → the catch logs parity_audit_record_error and resolves.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/review_audit/i.test(sql)) throw new Error("poisoned write");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordNativeGateDecision(env, { project: "owner/repo", pullNumber: 7, headSha: "abc123", conclusion: "failure", reasonCode: "slop_risk" }),
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes("parity_audit_record_error"))).toBe(true);
    warn.mockRestore();
  });
});

// ── computeParityReadiness — parity rate + cutover-readiness over the recorded data ──────────────────────────

describe("computeParityReadiness — runs computeGateParity / isParityCutoverReady over review_audit", () => {
  it("with ONLY gittensory-native rows (no reviewbot dual-run) there are no PAIRS → empty, no signal", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    for (let i = 1; i <= 40; i += 1) {
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: `sha${i}`, conclusion: "success" });
    }
    const report = await computeParityReadiness(env, { nowMs: Date.now() });
    expect(report.shadow).toBe(GITTENSORY_NATIVE_SOURCE);
    expect(report.authoritative).toBe("reviewbot");
    expect(report.rows).toEqual([]); // nothing to pair against → no rows
    expect(report.hasSignal).toBe(false);
  });

  it("PERFECT agreement over >= 30 paired commits → cutoverReady true, zero unsafe disagreements", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    const nowMs = Date.now();
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      // Both systems agree: even PRs both merge, odd PRs both hold.
      const conclusion = i % 2 === 0 ? "success" : "failure";
      const action = i % 2 === 0 ? "merge" : "hold";
      await seedReviewbotDecision(env, "owner/repo", i, sha, action, "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion });
    }
    const report = await computeParityReadiness(env, { nowMs });
    const row = report.rows.find((r) => r.project === "owner/repo");
    expect(row).toBeDefined();
    expect(row!.pairedSamples).toBe(35);
    expect(row!.disagree).toBe(0);
    expect(row!.unsafeDisagreements).toBe(0);
    expect(row!.agreementRate).toBe(1);
    expect(row!.cutoverReady).toBe(true);
    expect(report.hasSignal).toBe(true);
  });

  it("an UNSAFE disagreement (shadow merges where reviewbot holds) blocks cutover even at high agreement", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    const nowMs = Date.now();
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      // PR 1: reviewbot HOLDS but the shadow MERGES → the dangerous direction. Every other PR: both merge.
      await seedReviewbotDecision(env, "owner/repo", i, sha, i === 1 ? "hold" : "merge", "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion: "success" });
    }
    const report = await computeParityReadiness(env, { nowMs });
    const row = report.rows.find((r) => r.project === "owner/repo")!;
    expect(row.unsafeDisagreements).toBe(1);
    expect(row.cutoverReady).toBe(false); // any unsafe disagreement is a hard block
  });
});

// ── GET /v1/internal/parity — bearer-gated, flag-gated endpoint ──────────────────────────────────────────────

describe("GET /v1/internal/parity — bearer-gated, flag-gated endpoint", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("401s without the internal token (the /v1/internal/* middleware gate)", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    expect((await app.request("/v1/internal/parity", {}, env)).status).toBe(401);
    expect((await app.request("/v1/internal/parity", { headers: { authorization: "Bearer nope" } }, env)).status).toBe(401);
  });

  it("404s when GITTENSORY_REVIEW_PARITY_AUDIT is OFF — the endpoint does not exist (byte-identical to today)", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset → OFF
    const res = await app.request("/v1/internal/parity", { headers: bearer(env) }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("200s with the parity readiness report when ON and authorized", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    for (let i = 1; i <= 35; i += 1) {
      const sha = `sha${i}`;
      await seedReviewbotDecision(env, "owner/repo", i, sha, "merge", "slop_risk");
      await recordNativeGateDecision(env, { project: "owner/repo", pullNumber: i, headSha: sha, conclusion: "success" });
    }
    const res = await app.request("/v1/internal/parity", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authoritative: string; shadow: string; hasSignal: boolean; rows: Array<{ project: string; pairedSamples: number; cutoverReady: boolean }> };
    expect(body.authoritative).toBe("reviewbot");
    expect(body.shadow).toBe(GITTENSORY_NATIVE_SOURCE);
    const row = body.rows.find((r) => r.project === "owner/repo");
    expect(row?.pairedSamples).toBe(35);
    expect(row?.cutoverReady).toBe(true);
    // Privacy: aggregate only — never actor logins / trust internals.
    expect(JSON.stringify(body)).not.toMatch(/login|actor|reward|payout|trust|wallet|hotkey/i);
  });
});

// ── Flag-gated SHADOW recording driven through the review FINALIZE path (processors.ts) ───────────────────────
// processGitHubWebhook → maybePublishPrPublicSurface finalizes the gate and (flag-ON) records the native
// gate_decision via `recordNativeGateDecision`. These exercise the processors WIRING at the call site
// (`if (gateEvaluation) { const reasonCode = … ; await recordNativeGateDecision(…) }`) BOTH flag-ways, plus
// both sides of the reasonCode ternary (failure → blockers[0].code, non-failure → conclusion).

// A self-signed RSA PEM so the GitHub App can mint an installation token (gate check-run posting).
async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const b64 = Buffer.from(pkcs8 as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

// A confirmed-miner snapshot (confirmed status now feeds only on-chain scoring; the gate blocks every author
// the same on a configured blocker — #gate-nonconfirmed).
function parityMinerSnapshot(login: string) {
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

// Stand up a gate-enabled repo (no comment/label surface — gate only) so the finalize path runs the gate and
// reaches the parity-record call site with the minimum of moving parts.
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
    gateCheckMode: "enabled",
    linkedIssueGateMode: "block",
    requireLinkedIssue: true,
  });
  // .gittensory.yml authoritatively sets the linked-issue blocker to "block" (config-as-code).
  await upsertRepoFocusManifest(env, "JSONbored/gittensory", { gate: { linkedIssue: "block" } });
}

// The miner-list/token/check-run endpoints the gate finalize touches; `confirmedAuthor` toggles whether the
// gittensor miner list confirms the PR author. Confirmed status no longer changes the gate verdict (it feeds
// scoring); the configured blocker fails the gate for either author (#gate-nonconfirmed).
function stubFinalizeFetch(confirmedAuthor: string | null): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "https://api.gittensor.io/miners") return Response.json(confirmedAuthor ? [{ uid: 7, githubUsername: confirmedAuthor, githubId: "123", totalPrs: 4, totalMergedPrs: 3, totalOpenPrs: 1, totalClosedPrs: 0, totalOpenIssues: 0, totalClosedIssues: 0, totalSolvedIssues: 0, totalValidSolvedIssues: 0, isEligible: true, credibility: 1, eligibleRepoCount: 1 }] : []);
    if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.includes("/check-runs")) return Response.json({ id: 900 }, { status: 201 });
    return new Response("not found", { status: 404 });
  });
}

function prWebhook(deliveryId: string, author: string) {
  return {
    type: "github-webhook" as const,
    deliveryId,
    eventName: "pull_request",
    payload: {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      pull_request: { number: 42, title: "Gate without issue", state: "open", user: { login: author }, head: { sha: "gate123" }, labels: [], body: "No issue link." },
    },
  };
}

async function nativeRows(env: Env): Promise<Array<{ decision: string; summary: string; source: string }>> {
  const res = await env.DB.prepare("SELECT decision, summary, source FROM review_audit WHERE source = ? AND event_type = 'gate_decision'").bind(GITTENSORY_NATIVE_SOURCE).all<{ decision: string; summary: string; source: string }>();
  return res.results;
}

describe("recordNativeGateDecision wired into the review FINALIZE path (GITTENSORY_REVIEW_PARITY_AUDIT)", () => {
  it("FLAG-ON, FAILING gate (confirmed author + linked-issue block): records a 'hold' native row whose reasonCode is the blocker code (failure ternary side)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true", GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedGateEnabledRepo(env);
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: parityMinerSnapshot("contributor") }, 60_000);
    stubFinalizeFetch("contributor");
    try {
      await processJob(env, prWebhook("parity-finalize-fail", "contributor"));
    } finally {
      vi.unstubAllGlobals();
    }
    const rows = await nativeRows(env);
    // gateEvaluation.conclusion === "failure" → native action "hold"; reasonCode = blockers[0].code.
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: "hold", source: GITTENSORY_NATIVE_SOURCE });
    expect(rows[0]!.summary).toBe("missing_linked_issue");
  });

  it("FLAG-ON, NON-confirmed author + linked-issue block: gated NORMALLY → FAILURE → a comparable 'hold' native row (#gate-nonconfirmed)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true", GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedGateEnabledRepo(env);
    stubFinalizeFetch(null); // miner list empty → author unconfirmed, but confirmed status no longer changes the verdict
    try {
      await processJob(env, prWebhook("parity-finalize-nonconfirmed", "contributor"));
    } finally {
      vi.unstubAllGlobals();
    }
    // The blocker (missing linked issue) fails the gate regardless of confirmed status → failure → native action
    // "hold", which IS comparable → recordNativeGateDecision writes one row with the blocker code as the reason.
    const rows = await nativeRows(env);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: "hold", source: GITTENSORY_NATIVE_SOURCE });
    expect(rows[0]!.summary).toBe("missing_linked_issue");
  });

  it("FLAG-OFF (default) on the CLOUD WORKER: the finalize path records NOTHING — byte-identical review path, no native row", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() }); // flag unset → OFF
    delete env.SELFHOST_TRANSIENT_CACHE; // simulate the cloud worker (no self-host binding)
    await seedGateEnabledRepo(env);
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: parityMinerSnapshot("contributor") }, 60_000);
    stubFinalizeFetch("contributor");
    try {
      await processJob(env, prWebhook("parity-finalize-off", "contributor"));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await nativeRows(env)).toEqual([]);
  });

  it("FLAG-OFF (default) on a SELF-HOSTED instance: the finalize path STILL records (fleet telemetry gap fix)", async () => {
    // SELFHOST_TRANSIENT_CACHE present (createTestEnv's default) === a self-hosted instance; the flag stays
    // unset, matching every self-hosted instance in production. exportOrbBatch needs this row to exist.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedGateEnabledRepo(env);
    await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: parityMinerSnapshot("contributor") }, 60_000);
    stubFinalizeFetch("contributor");
    try {
      await processJob(env, prWebhook("parity-finalize-selfhost", "contributor"));
    } finally {
      vi.unstubAllGlobals();
    }
    const rows = await nativeRows(env);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ decision: "hold", source: GITTENSORY_NATIVE_SOURCE, summary: "missing_linked_issue" });
  });
});
