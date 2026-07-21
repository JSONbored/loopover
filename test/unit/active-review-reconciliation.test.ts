import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveReviewReconciliationManifestOverrideCacheForTest,
  isActiveReviewReconciliationEnabled,
  resolveActiveReviewReconciliationManifestOverride,
  runActiveReviewReconciliation,
  STALE_ACTIVE_REVIEW_MIN_AGE_MS,
} from "../../src/review/active-review-reconciliation";
import { hasActiveReviewForHeadSha, startActiveReviewTracking, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as backfillModule from "../../src/github/backfill";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as focusManifestLoaderModule from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const SELF_REPO = "JSONbored/loopover";

describe("isActiveReviewReconciliationEnabled — default OFF, truthy convention", () => {
  it("matches the codebase's shared truthy-string convention", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: on })).toBe(true);
  });

  it("whitespace-padded truthy values still activate (matches isRagEnabled/isPrReconciliationEnabled)", () => {
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "true\n" })).toBe(true);
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: " 1 " })).toBe(true);
  });

  it("a present manifest override wins outright over the env flag, in both directions (#webhook-reorder-clobber)", () => {
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "false" }, { present: true, enabled: true })).toBe(true);
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "true" }, { present: true, enabled: false })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "true" }, { present: false, enabled: false })).toBe(true);
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "false" }, undefined)).toBe(false);
  });
});

describe("resolveActiveReviewReconciliationManifestOverride — config-as-code lookup (#webhook-reorder-clobber)", () => {
  beforeEach(() => {
    clearActiveReviewReconciliationManifestOverrideCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the self-repo's configured activeReviewReconciliation block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { activeReviewReconciliation: { enabled: true } });

    expect(await resolveActiveReviewReconciliationManifestOverride(env)).toEqual({ present: true, enabled: true });
  });

  it("returns present: false when the self-repo has no activeReviewReconciliation block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveActiveReviewReconciliationManifestOverride(env)).toEqual({ present: false, enabled: false });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveActiveReviewReconciliationManifestOverride(env)).toEqual({ present: false, enabled: false });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("active_review_reconciliation_manifest_override_error"))).toBe(true);
  });

  it("within the 60s TTL, reuses the cached override instead of re-reading the manifest", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { activeReviewReconciliation: { enabled: true } });
    const t0 = Date.parse("2026-07-21T00:00:00Z");
    expect(await resolveActiveReviewReconciliationManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    env.DB.prepare = (() => {
      throw new Error("should not be queried on a cache hit");
    }) as typeof env.DB.prepare;
    expect(await resolveActiveReviewReconciliationManifestOverride(env, t0 + 30_000)).toEqual({ present: true, enabled: true });
  });

  it("re-reads the manifest once the 60s TTL has elapsed", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { activeReviewReconciliation: { enabled: true } });
    const t0 = Date.parse("2026-07-21T00:00:00Z");
    expect(await resolveActiveReviewReconciliationManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    await upsertRepoFocusManifest(env, SELF_REPO, { activeReviewReconciliation: { enabled: false } });
    expect(await resolveActiveReviewReconciliationManifestOverride(env, t0 + 60_001)).toEqual({ present: true, enabled: false });
  });
});

describe("runActiveReviewReconciliation (#webhook-reorder-clobber)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedStaleActiveRow(env: Env, repoFullName: string, pullNumber: number, installationId: number, ageMs: number) {
    await upsertRepositoryFromGitHub(env, { name: repoFullName.split("/")[1]!, full_name: repoFullName, private: false, owner: { login: repoFullName.split("/")[0]! } }, installationId);
    await startActiveReviewTracking(env, { repoFullName, pullNumber, headSha: "sha1", deliveryId: "delivery-1" });
    // Backdate startedAt directly -- startActiveReviewTracking always stamps "now".
    await env.DB.prepare("update active_review_tracking set started_at = ? where repo_full_name = ? and pull_number = ?")
      .bind(new Date(Date.now() - ageMs).toISOString(), repoFullName, pullNumber)
      .run();
  }

  it("terminalizes a stale row a LIVE GitHub check confirms is closed", async () => {
    resetMetrics();
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/repo", 1, 9500, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("closed");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([{ repoFullName: "owner/repo", pullNumber: 1 }]);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 1, "sha1")).toBe(false);
    expect(counterValue("loopover_active_review_reconciliation_terminalized_total", { repo: "owner/repo" })).toBe(1);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("active_review_reconciliation_orphan_terminalized"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "active_review_reconciliation_orphan_terminalized", repository: "owner/repo", pullNumber: 1 });
  });

  it("leaves a stale row alone when the LIVE check says the PR is still open", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/repo", 2, 9501, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("open");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 2, "sha1")).toBe(true);
  });

  it("leaves a stale row alone when the LIVE check itself fails (undefined) -- never force-closes on an inconclusive read", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/repo", 3, 9502, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce(undefined);

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(await hasActiveReviewForHeadSha(env, "owner/repo", 3, "sha1")).toBe(true);
  });

  it("never considers a row younger than the staleness cutoff -- a genuinely in-flight review is not a candidate", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/repo", 4, 9503, STALE_ACTIVE_REVIEW_MIN_AGE_MS - 60_000);
    const liveSpy = vi.spyOn(backfillModule, "fetchLivePullRequestState");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it("skips a repo with no installation -- never spends a live GitHub call it couldn't authenticate anyway", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } }); // no installation id
    await startActiveReviewTracking(env, { repoFullName: "owner/no-install", pullNumber: 5, headSha: "sha1", deliveryId: "delivery-1" });
    await env.DB.prepare("update active_review_tracking set started_at = ? where repo_full_name = ? and pull_number = ?")
      .bind(new Date(Date.now() - STALE_ACTIVE_REVIEW_MIN_AGE_MS - 60_000).toISOString(), "owner/no-install", 5)
      .run();
    const liveSpy = vi.spyOn(backfillModule, "fetchLivePullRequestState");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it("REGRESSION: an explicit review.activeReviewReconciliation: false excludes an otherwise-eligible repo's rows from the scan entirely", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/opted-out", 9, 9507, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    await upsertRepoFocusManifest(env, "owner/opted-out", { review: { activeReviewReconciliation: false } });
    const liveSpy = vi.spyOn(backfillModule, "fetchLivePullRequestState");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(liveSpy).not.toHaveBeenCalled(); // opted-out before any GitHub call is ever spent
    expect(await hasActiveReviewForHeadSha(env, "owner/opted-out", 9, "sha1")).toBe(true); // row untouched
  });

  it("an explicit review.activeReviewReconciliation: true is a no-op -- the repo's rows are scanned exactly as when unset", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/opted-in", 10, 9508, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    await upsertRepoFocusManifest(env, "owner/opted-in", { review: { activeReviewReconciliation: true } });
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("closed");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([{ repoFullName: "owner/opted-in", pullNumber: 10 }]);
  });

  it("fails OPEN on a manifest-load error for the row's own repo -- a config-read blip must never silently exclude a row from reconciliation", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/manifest-errors", 11, 9509, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    vi.spyOn(focusManifestLoaderModule, "loadRepoFocusManifest").mockRejectedValueOnce(new Error("manifest load failed"));
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("closed");

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([{ repoFullName: "owner/manifest-errors", pullNumber: 11 }]);
  });

  it("fails safe per-row: an error on one row is logged and the scan continues to the next row", async () => {
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/erroring-repo", 6, 9504, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    await seedStaleActiveRow(env, "owner/ok-repo", 7, 9505, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    const realGetRepository = repositoriesModule.getRepository;
    vi.spyOn(repositoriesModule, "getRepository").mockImplementation(async (envArg, fullName) => {
      if (fullName === "owner/erroring-repo") throw new Error("D1 read error");
      return realGetRepository(envArg, fullName);
    });
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("closed");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([{ repoFullName: "owner/ok-repo", pullNumber: 7 }]); // erroring-repo's row is skipped, not fatal
    expect(errors.mock.calls.some((call) => String(call[0]).includes("active_review_reconciliation_row_error") && String(call[0]).includes("owner/erroring-repo"))).toBe(true);
  });

  it("fails safe at the top level: a total scan failure is logged and returns an empty result instead of throwing", async () => {
    const env = createTestEnv();
    vi.spyOn(repositoriesModule, "listStaleActiveReviewTracking").mockRejectedValueOnce(new Error("D1 unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runActiveReviewReconciliation(env)).resolves.toEqual([]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("active_review_reconciliation_error"))).toBe(true);
  });

  it("a concurrent terminalize race (row already terminal by the time this pass writes) is not double-reported", async () => {
    resetMetrics();
    const env = createTestEnv();
    await seedStaleActiveRow(env, "owner/repo", 8, 9506, STALE_ACTIVE_REVIEW_MIN_AGE_MS + 60_000);
    vi.spyOn(backfillModule, "fetchLivePullRequestState").mockResolvedValueOnce("closed");
    vi.spyOn(repositoriesModule, "terminalizeActiveReviewTracking").mockResolvedValueOnce(false); // another pass won the race

    const reconciled = await runActiveReviewReconciliation(env);

    expect(reconciled).toEqual([]);
    expect(counterValue("loopover_active_review_reconciliation_terminalized_total", { repo: "owner/repo" })).toBe(0);
  });
});
