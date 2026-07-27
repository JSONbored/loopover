import { describe, expect, it } from "vitest";
import { bumpPullRequestLowConfidenceHold, getPullRequest, listAuditEventsForTarget, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP, applyLowConfidenceHoldCap, isLowConfidenceHoldCapped } from "../../src/review/low-confidence-hold-cap";
import { createTestEnv } from "../helpers/d1";

async function seedPr(env: Env, headSha: string): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: 31, account: { login: "alice", id: 31, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "alice/repo", private: false, owner: { login: "alice" } }, 31);
  await upsertPullRequestFromGitHub(env, "alice/repo", { number: 9, title: "PR", state: "open", user: { login: "bob" }, head: { sha: headSha }, labels: [], body: "b" });
}

async function push(env: Env, headSha: string): Promise<void> {
  await upsertPullRequestFromGitHub(env, "alice/repo", { number: 9, title: "PR", state: "open", user: { login: "bob" }, head: { sha: headSha }, labels: [], body: "b" });
}

// #9034: a blocker below the close-confidence floor still blocks, but under the default `hold_for_review`
// disposition it converts a one-shot close into an OPEN hold — with nothing counting how many times the same PR
// re-entered that hold. So a PR shaped to keep drawing low-confidence blockers survived indefinitely, cost a
// maintainer on every roll, and (with the re-roll surface) could be walked toward a clean merge from there.
describe("bumpPullRequestLowConfidenceHold (#9034)", () => {
  it("counts each distinct head exactly once, however many passes re-evaluate it", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");

    // The re-gate sweep, a CI event and a label webhook can all re-evaluate one commit within minutes; every
    // one of them would otherwise burn the cap against a single genuine hold.
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1")).toBe(1);
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1")).toBe(1);
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1")).toBe(1);

    const stored = await getPullRequest(env, "alice/repo", 9);
    expect({ count: stored?.lowConfidenceHoldCount, head: stored?.lowConfidenceHoldHeadSha }).toEqual({ count: 1, head: "sha-1" });
  });

  it("advances on each new roll and never resets on a push — repeated holds ARE the pattern being capped", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");

    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1")).toBe(1);
    await push(env, "sha-2");
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-2")).toBe(2);
    await push(env, "sha-3");
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-3")).toBe(3);
    await push(env, "sha-4");
    // The (CAP + 1)th roll is the one that exceeds the cap, so the close the hold was suppressing fires.
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-4")).toBe(AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP + 1);
  });

  it("does not count a pass with no head SHA — a sparse payload must not silently exhaust the cap", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1");

    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, null)).toBe(1);
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, undefined)).toBe(1);
    expect((await getPullRequest(env, "alice/repo", 9))?.lowConfidenceHoldHeadSha).toBe("sha-1");
  });

  it("returns zero for a PR that has no row rather than creating one", async () => {
    const env = createTestEnv();
    expect(await bumpPullRequestLowConfidenceHold(env, "alice/repo", 404, "sha-1")).toBe(0);
    expect(await getPullRequest(env, "alice/repo", 404)).toBeNull();
  });

  it("leaves the counter alone across an ordinary GitHub resync", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestLowConfidenceHold(env, "alice/repo", 9, "sha-1");
    await push(env, "sha-2");
    await push(env, "sha-3");
    // Pushes alone never advance it — only an actual low-confidence hold does.
    expect((await getPullRequest(env, "alice/repo", 9))?.lowConfidenceHoldCount).toBe(1);
  });

  it("caps at a number that still allows a real uncertain verdict to reach a human more than once", () => {
    expect(AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP).toBeGreaterThanOrEqual(2);
  });

  it("trips only once the budget is exceeded, not on the last hold inside it", () => {
    expect(isLowConfidenceHoldCapped(0)).toBe(false);
    expect(isLowConfidenceHoldCapped(AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP)).toBe(false);
    expect(isLowConfidenceHoldCapped(AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP + 1)).toBe(true);
  });
});

describe("applyLowConfidenceHoldCap (#9034)", () => {
  const hold = { reason: "an AI-reviewer defect finding's confidence is below the configured close-confidence floor (0.93)" };
  const target = (headSha: string | null) => ({ repoFullName: "alice/repo", pullNumber: 9, headSha });

  it("passes through when there is no hold to cap", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    expect(await applyLowConfidenceHoldCap(env, target("sha-1"), undefined)).toBeUndefined();
    // Nothing was counted — a pass with no hold must not spend budget.
    expect((await getPullRequest(env, "alice/repo", 9))?.lowConfidenceHoldCount).toBe(0);
  });

  it("keeps holding while the PR still has budget", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    expect(await applyLowConfidenceHoldCap(env, target("sha-1"), hold)).toBe(hold);
    await push(env, "sha-2");
    expect(await applyLowConfidenceHoldCap(env, target("sha-2"), hold)).toBe(hold);
  });

  it("lifts the hold once the budget is spent, and says so in the audit trail", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    for (let roll = 1; roll <= AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP; roll += 1) {
      await push(env, `sha-${roll}`);
      expect(await applyLowConfidenceHoldCap(env, target(`sha-${roll}`), hold)).toBe(hold);
    }
    await push(env, "sha-over");

    // The roll past the cap: the close this hold was suppressing now fires.
    expect(await applyLowConfidenceHoldCap(env, target("sha-over"), hold)).toBeUndefined();

    const audits = await listAuditEventsForTarget(env, { repoFullName: "alice/repo", pullNumber: 9, limit: 20 });
    const capped = audits.find((event) => event.eventType === "agent.low_confidence_hold.capped");
    expect(capped?.detail).toContain("the suppressed close now proceeds");
  });

  it("stays lifted on every later pass, not just the one that crossed the cap", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    for (let roll = 1; roll <= AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP + 1; roll += 1) {
      await push(env, `sha-${roll}`);
      await applyLowConfidenceHoldCap(env, target(`sha-${roll}`), hold);
    }
    await push(env, "sha-later");
    expect(await applyLowConfidenceHoldCap(env, target("sha-later"), hold)).toBeUndefined();
  });
});
