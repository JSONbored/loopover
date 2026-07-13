import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrReconciliationEnabled, runOpenPrReconciliation } from "../../src/review/pr-reconciliation";
import { getPullRequest, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as backfillModule from "../../src/github/backfill";
import * as repositoriesModule from "../../src/db/repositories";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

describe("isPrReconciliationEnabled — default OFF, truthy convention", () => {
  it("matches the codebase's shared truthy-string convention", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isPrReconciliationEnabled({ GITTENSORY_PR_RECONCILIATION: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isPrReconciliationEnabled({ GITTENSORY_PR_RECONCILIATION: on })).toBe(true);
  });
});

describe("runOpenPrReconciliation (#audit-open-pr-reconciliation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("REGRESSION (#3782/#3793): catches up a missing PR — fetches it, upserts it, and enqueues a regate", async () => {
    resetMetrics();
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "lost-repo", full_name: "owner/lost-repo", private: false, owner: { login: "owner" } }, 9400);
    await upsertRepositorySettings(env, { repoFullName: "owner/lost-repo", autonomy: { merge: "auto" } });
    vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValueOnce({ repoFullName: "owner/lost-repo", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [7] });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/7")) return Response.json({ number: 7, title: "Lost PR", state: "open", user: { login: "c" }, head: { sha: "a7" }, labels: [], body: "" });
      return Response.json({});
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runOpenPrReconciliation(env);

    expect(found).toEqual([{ repoFullName: "owner/lost-repo", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [7] }]);
    expect(counterValue("loopover_open_pr_reconciliation_missing_total", { repo: "owner/lost-repo" })).toBe(1);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("open_pr_reconciliation_divergence"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "open_pr_reconciliation_divergence", repository: "owner/lost-repo", missingNumbers: [7] });
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-pr", repoFullName: "owner/lost-repo", prNumber: 7, installationId: 9400 })]);
    const stored = await getPullRequest(env, "owner/lost-repo", 7);
    expect(stored).toMatchObject({ number: 7, title: "Lost PR" });
  });

  it("takes no action when the list-diff finds no divergence", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "clean-repo", full_name: "owner/clean-repo", private: false, owner: { login: "owner" } }, 9401);
    await upsertRepositorySettings(env, { repoFullName: "owner/clean-repo", autonomy: { merge: "auto" } });
    vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValueOnce({ repoFullName: "owner/clean-repo", remoteOpenCount: 1, localOpenCount: 1, missingNumbers: [] });

    const found = await runOpenPrReconciliation(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("never reconciles a registered-but-uninstalled repo (#sweep-uninstalled-budget-waste)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_REPOS: "owner/no-install" });
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } }); // no installation id
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    const reconcileSpy = vi.spyOn(backfillModule, "reconcileOpenPullRequests");

    const found = await runOpenPrReconciliation(env);

    expect(found).toEqual([]);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("watches an ALLOWLISTED (LOOPOVER_REVIEW_REPOS) installed repo even with no autonomy configured", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_REPOS: "owner/allowlisted-repo" });
    await upsertRepositoryFromGitHub(env, { name: "allowlisted-repo", full_name: "owner/allowlisted-repo", private: false, owner: { login: "owner" } }, 9407);
    const reconcileSpy = vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValueOnce({ repoFullName: "owner/allowlisted-repo", remoteOpenCount: 0, localOpenCount: 0, missingNumbers: [] });

    await runOpenPrReconciliation(env);

    expect(reconcileSpy).toHaveBeenCalledWith(env, "owner/allowlisted-repo");
  });

  it("skips a repo that is neither allowlisted nor agent-configured", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } }, 9402);
    const reconcileSpy = vi.spyOn(backfillModule, "reconcileOpenPullRequests");

    const found = await runOpenPrReconciliation(env);

    expect(found).toEqual([]);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("fails safe per-repo: a load error on one repo is logged and the scan continues to the next repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "erroring-repo", full_name: "owner/erroring-repo", private: false, owner: { login: "owner" } }, 9403);
    await upsertRepositorySettings(env, { repoFullName: "owner/erroring-repo", autonomy: { merge: "auto" } });
    await upsertRepositoryFromGitHub(env, { name: "ok-repo", full_name: "owner/ok-repo", private: false, owner: { login: "owner" } }, 9404);
    await upsertRepositorySettings(env, { repoFullName: "owner/ok-repo", autonomy: { merge: "auto" } });
    vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockImplementation(async (_env, repoFullName) => {
      if (repoFullName === "owner/erroring-repo") throw new Error("GitHub read error");
      return { repoFullName, remoteOpenCount: 0, localOpenCount: 0, missingNumbers: [] };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runOpenPrReconciliation(env);

    expect(found).toEqual([]); // ok-repo had no divergence, but the scan reached it despite erroring-repo's failure
    expect(errors.mock.calls.some((call) => String(call[0]).includes("open_pr_reconciliation_repo_error") && String(call[0]).includes("owner/erroring-repo"))).toBe(true);
    expect(sent).toEqual([]);
  });

  it("fails safe at the top level: a total scan failure is logged and returns an empty result instead of throwing", async () => {
    const env = createTestEnv();
    const listSpy = vi.spyOn(repositoriesModule, "listRepositories").mockRejectedValueOnce(new Error("D1 unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runOpenPrReconciliation(env)).resolves.toEqual([]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("open_pr_reconciliation_error"))).toBe(true);
    listSpy.mockRestore();
  });

  it("logs open_pr_reconciliation_catch_up_fetch_failed and does not throw when the missing PR's live fetch fails", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "fetch-fails", full_name: "owner/fetch-fails", private: false, owner: { login: "owner" } }, 9405);
    await upsertRepositorySettings(env, { repoFullName: "owner/fetch-fails", autonomy: { merge: "auto" } });
    vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValueOnce({ repoFullName: "owner/fetch-fails", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [9] });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runOpenPrReconciliation(env)).resolves.toEqual([{ repoFullName: "owner/fetch-fails", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [9] }]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("open_pr_reconciliation_catch_up_fetch_failed") && String(call[0]).includes("owner/fetch-fails"))).toBe(true);
    expect(await getPullRequest(env, "owner/fetch-fails", 9)).toBeNull();
  });

  it("logs open_pr_reconciliation_catch_up_failed and does not throw when the enqueue itself fails", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue send error");
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "send-fails", full_name: "owner/send-fails", private: false, owner: { login: "owner" } }, 9406);
    await upsertRepositorySettings(env, { repoFullName: "owner/send-fails", autonomy: { merge: "auto" } });
    vi.spyOn(backfillModule, "reconcileOpenPullRequests").mockResolvedValueOnce({ repoFullName: "owner/send-fails", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [3] });
    vi.stubGlobal("fetch", async () => Response.json({ number: 3, title: "PR3", state: "open", user: { login: "c" }, head: { sha: "a3" }, labels: [], body: "" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runOpenPrReconciliation(env)).resolves.toEqual([{ repoFullName: "owner/send-fails", remoteOpenCount: 1, localOpenCount: 0, missingNumbers: [3] }]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("open_pr_reconciliation_catch_up_failed") && String(call[0]).includes("owner/send-fails"))).toBe(true);
  });
});
