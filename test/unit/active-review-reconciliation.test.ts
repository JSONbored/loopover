import { afterEach, describe, expect, it, vi } from "vitest";
import { isActiveReviewReconciliationEnabled, runActiveReviewReconciliation, STALE_ACTIVE_REVIEW_MIN_AGE_MS } from "../../src/review/active-review-reconciliation";
import { hasActiveReviewForHeadSha, startActiveReviewTracking, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as backfillModule from "../../src/github/backfill";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

describe("isActiveReviewReconciliationEnabled — default OFF, truthy convention", () => {
  it("matches the codebase's shared truthy-string convention", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: on })).toBe(true);
  });

  it("whitespace-padded truthy values still activate (matches isRagEnabled/isPrReconciliationEnabled)", () => {
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: "true\n" })).toBe(true);
    expect(isActiveReviewReconciliationEnabled({ LOOPOVER_ACTIVE_REVIEW_RECONCILIATION: " 1 " })).toBe(true);
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
