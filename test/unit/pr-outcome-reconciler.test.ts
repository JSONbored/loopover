import { describe, expect, it, vi } from "vitest";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { PR_OUTCOME_RECONCILE_LIMIT, PR_OUTCOME_RECONCILE_LOOKBACK_MS, reconcileMissingPrOutcomes } from "../../src/review/pr-outcome-reconciler";
import { createTestEnv } from "../helpers/d1";

async function seedRepo(env: Env): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: 55, account: { login: "alice", id: 55, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "alice/repo", private: false, owner: { login: "alice" } }, 55);
}

async function seedPr(env: Env, number: number, opts: { state: string; mergedAt?: string | null }): Promise<void> {
  await upsertPullRequestFromGitHub(env, "alice/repo", {
    number,
    title: `PR ${number}`,
    state: opts.state,
    user: { login: "bob" },
    head: { sha: `sha${number}` },
    labels: [],
    body: "b",
    ...(opts.mergedAt ? { merged_at: opts.mergedAt } : {}),
  });
}

async function addReviewAudit(env: Env, number: number, eventType: string): Promise<void> {
  await env.DB.prepare("INSERT INTO review_audit (id, project, target_id, event_type, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), "alice/repo", `alice/repo#${number}`, eventType, "closed", new Date().toISOString())
    .run();
}

async function outcomeRows(env: Env, number: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM review_audit WHERE target_id = ? AND event_type = 'pr_outcome'")
    .bind(`alice/repo#${number}`)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

// #9026: pr_outcome is the realized ground truth the fleet calibration export INNER JOINs gate_decision
// against, so a PR missing one vanishes from calibration entirely — neither numerator nor denominator. Both
// writers are in-process and best-effort, and nothing scanned for the gap: the repair sweep only visits OPEN
// PRs. The losses skew toward the gate's mistakes (a superseded close is by definition a wrong close), so their
// absence biased published accuracy UPWARD.
describe("reconcileMissingPrOutcomes (#9026)", () => {
  it("backfills a closed PR that has a gate decision but no outcome", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 1, { state: "closed" });
    await addReviewAudit(env, 1, "gate_decision");

    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 1, backfilled: 1 });
    expect(await outcomeRows(env, 1)).toBe(1);
  });

  it("records a merged PR as merged, not closed — GitHub reports both as state=closed", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 2, { state: "closed", mergedAt: new Date().toISOString() });
    await addReviewAudit(env, 2, "gate_decision");

    await reconcileMissingPrOutcomes(env);
    const row = await env.DB.prepare("SELECT decision FROM review_audit WHERE target_id = ? AND event_type = 'pr_outcome'")
      .bind("alice/repo#2")
      .first<{ decision: string }>();
    // Recording a merge as a plain close would invert the very judgment calibration is scoring.
    expect(row?.decision).toBe("merged");
  });

  it("leaves open PRs alone — they have no realized outcome yet", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 3, { state: "open" });
    await addReviewAudit(env, 3, "gate_decision");

    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 0, backfilled: 0 });
  });

  it("ignores a closed PR the gate never evaluated — no prediction means nothing to pair an outcome with", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 4, { state: "closed" });

    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 0, backfilled: 0 });
    expect(await outcomeRows(env, 4)).toBe(0);
  });

  it("skips a PR whose outcome was already recorded, and stays idempotent across runs", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 5, { state: "closed" });
    await addReviewAudit(env, 5, "gate_decision");

    await reconcileMissingPrOutcomes(env);
    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 0, backfilled: 0 });
    expect(await outcomeRows(env, 5)).toBe(1);
  });

  it("ignores anything older than the lookback window", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 6, { state: "closed" });
    await addReviewAudit(env, 6, "gate_decision");

    expect(await reconcileMissingPrOutcomes(env, Date.now() + PR_OUTCOME_RECONCILE_LOOKBACK_MS + 60_000)).toEqual({ scanned: 0, backfilled: 0 });
  });

  it("returns an empty result instead of throwing when the scan fails — a repair pass must not break its tick", async () => {
    const env = createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db unavailable");
    });

    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 0, backfilled: 0 });
    expect(warn.mock.calls.some(([line]) => String(line).includes("pr_outcome_reconcile_scan_failed"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("counts a scanned row it could not write, rather than reporting it as backfilled", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    await seedPr(env, 7, { state: "closed" });
    await addReviewAudit(env, 7, "gate_decision");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes = await import("../../src/review/outcomes-wire");
    vi.spyOn(outcomes, "recordTerminalActionOutcome").mockRejectedValue(new Error("write failed"));

    expect(await reconcileMissingPrOutcomes(env)).toEqual({ scanned: 1, backfilled: 0 });
    expect(warn.mock.calls.some(([line]) => String(line).includes("pr_outcome_reconcile_write_failed"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("bounds each run so a large backlog drains across runs instead of blocking one", () => {
    expect(PR_OUTCOME_RECONCILE_LIMIT).toBeGreaterThan(0);
    expect(PR_OUTCOME_RECONCILE_LIMIT).toBeLessThanOrEqual(1000);
  });
});
