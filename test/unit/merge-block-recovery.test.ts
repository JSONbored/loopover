import { describe, expect, it } from "vitest";
import { getPullRequest, markPullRequestMergeBlocked, bumpPullRequestMergeAttempt, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertInstallation } from "../../src/db/repositories";
import { activeMergeBlockedSha, classifyMergeFailure, INFRA_MERGE_BLOCK_TTL_MS, isMergeBlockInEffect, MERGE_RETRY_CAP } from "../../src/services/merge-failure";
import { AGENT_LABEL_NEEDS_REVIEW, AGENT_LABEL_READY, planAgentMaintenanceActions } from "../../src/settings/agent-actions";
import { createTestEnv } from "../helpers/d1";

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function seedPr(env: Env, headSha: string): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: 77, account: { login: "alice", id: 77, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "alice/repo", private: false, owner: { login: "alice" } }, 77);
  await upsertPullRequestFromGitHub(env, "alice/repo", { number: 5, title: "PR", state: "open", user: { login: "bob" }, head: { sha: headSha }, labels: [], body: "b" });
}

// #9012: `merge_blocked_sha` was written for every terminal class and cleared by nothing — its only documented
// escape was the contributor pushing a new commit. But a 401 (App suspended / key rotated) and an exhausted
// secondary-rate-limit window are properties of the INSTALLATION, not of the commit: they fail every in-flight
// merge in the fleet at once, and no contributor has any reason to push, because the PR looks green, approved,
// and (with review_state_label on) ready-to-merge. One token rotation therefore stranded every merge it caught,
// permanently and invisibly. Infra-scoped blocks now carry an expiry and are re-probed.
describe("terminal merge failures distinguish infra causes from commit causes (#9012)", () => {
  it("scopes a rejected installation token and an exhausted rate-limit window to infra, and real policy/conflict causes to the commit", () => {
    expect(classifyMergeFailure(httpError(401, "Bad credentials")).scope).toBe("infra");
    expect(classifyMergeFailure(httpError(403, "You have exceeded a secondary rate limit")).scope).toBe("infra");
    expect(classifyMergeFailure(httpError(403, "Must have admin rights")).scope).toBe("commit");
    expect(classifyMergeFailure(httpError(405, "Pull Request is not mergeable")).scope).toBe("commit");
    expect(classifyMergeFailure(httpError(405, "Base branch was modified")).scope).toBe("commit");
    expect(classifyMergeFailure(httpError(405, "A merge for this pull request is already in progress")).scope).toBe("commit");
    expect(classifyMergeFailure(httpError(409, "required status check is expected")).scope).toBe("commit");
    expect(classifyMergeFailure(new Error("merge conflict between base and head")).scope).toBe("commit");
    expect(classifyMergeFailure(new Error("something else entirely"))).toEqual({ terminal: false, scope: "commit", reason: "something else entirely" });
  });

  it("keeps a 401 terminal for the pass — failing fast against a known-bad credential is still the point", () => {
    expect(classifyMergeFailure(httpError(401, "Bad credentials")).terminal).toBe(true);
  });
});

describe("a merge block only suppresses the merge while it is actually in effect (#9012)", () => {
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");

  it("holds a commit-scoped block (no expiry) for as long as the head is unchanged", () => {
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: null }, "abc", NOW)).toBe(true);
  });

  it("lets go once the head advances, for either scope", () => {
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: null }, "def", NOW)).toBe(false);
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: new Date(NOW + 60_000).toISOString() }, "def", NOW)).toBe(false);
  });

  it("holds an infra-scoped block until its expiry and releases it after — the whole recovery path", () => {
    const until = new Date(NOW + 60_000).toISOString();
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: until }, "abc", NOW)).toBe(true);
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: until }, "abc", NOW + 61_000)).toBe(false);
  });

  it("treats an absent block, an absent head, and an unparseable expiry as not-blocked", () => {
    expect(isMergeBlockInEffect({ mergeBlockedSha: null, mergeBlockedUntil: null }, "abc", NOW)).toBe(false);
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: null }, null, NOW)).toBe(false);
    expect(isMergeBlockInEffect({}, "abc", NOW)).toBe(false);
    // A malformed timestamp must never be the thing that strands a green PR forever — that is the exact
    // failure this fix removes, so it must not be reintroduced by a bad write.
    expect(isMergeBlockInEffect({ mergeBlockedSha: "abc", mergeBlockedUntil: "not-a-date" }, "abc", NOW)).toBe(false);
  });

  it("hands the planner the stored SHA while blocked and null once the block lapses", () => {
    const until = new Date(NOW + 60_000).toISOString();
    expect(activeMergeBlockedSha({ mergeBlockedSha: "abc", mergeBlockedUntil: until }, "abc", NOW)).toBe("abc");
    // A lapsed block must be indistinguishable from never having been blocked — that is what makes the planner
    // re-probe the merge instead of waiting for a commit nobody has any reason to push.
    expect(activeMergeBlockedSha({ mergeBlockedSha: "abc", mergeBlockedUntil: until }, "abc", NOW + 61_000)).toBeNull();
    expect(activeMergeBlockedSha({ mergeBlockedSha: null, mergeBlockedUntil: null }, "abc", NOW)).toBeNull();
    expect(activeMergeBlockedSha({ mergeBlockedSha: "abc", mergeBlockedUntil: null }, "abc", NOW)).toBe("abc");
  });

  it("is a real TTL, not a token constant", () => {
    expect(INFRA_MERGE_BLOCK_TTL_MS).toBeGreaterThan(60_000);
  });
});

describe("markPullRequestMergeBlocked persists the scope (#9012)", () => {
  it("writes no expiry for a commit-scoped block and leaves the attempt counter alone", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    await markPullRequestMergeBlocked(env, "alice/repo", 5, "sha-1", "branch conflicts with base");

    const stored = await getPullRequest(env, "alice/repo", 5);
    expect({ until: stored?.mergeBlockedUntil ?? null, attempts: stored?.mergeAttemptCount }).toEqual({ until: null, attempts: 1 });
    expect(stored?.mergeBlockedReason).toContain("conflicts");
  });

  it("writes an expiry for an infra-scoped block and zeroes the attempt counter so the re-probe starts fresh", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    const expiresAt = new Date(Date.now() + INFRA_MERGE_BLOCK_TTL_MS).toISOString();
    await markPullRequestMergeBlocked(env, "alice/repo", 5, "sha-1", "installation token rejected (401)", expiresAt);

    const stored = await getPullRequest(env, "alice/repo", 5);
    expect({ until: stored?.mergeBlockedUntil, attempts: stored?.mergeAttemptCount }).toEqual({ until: expiresAt, attempts: 0 });
    // And the block genuinely lapses: this is the "merges autonomously with no new commit" acceptance criterion.
    expect(isMergeBlockInEffect(stored!, "sha-1", Date.parse(expiresAt) + 1)).toBe(false);
  });

  it("truncates an overlong reason at the persisted 280-char cap", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await markPullRequestMergeBlocked(env, "alice/repo", 5, "sha-1", "x".repeat(400));
    expect((await getPullRequest(env, "alice/repo", 5))?.mergeBlockedReason).toHaveLength(280);
  });
});

// #9693: a 429 secondary-rate-limit window that burns MERGE_RETRY_CAP must persist an INFRA-scoped (expiring)
// block, not a commit-scoped one that strands the PR until an unrelated commit lands. handleMergeFailure derives
// the expiry from classifyMergeFailure(...).scope, so we drive that composition exactly as the executor does.
describe("a rate-limit-exhausted merge persists a self-healing infra block (#9693)", () => {
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");
  const blockFor = (error: unknown) => {
    // Mirror handleMergeFailure's retry-cap path: on exhaustion the classified scope decides the expiry.
    const { scope, terminal } = classifyMergeFailure(error);
    // A 429/rate-limited failure is non-terminal, so it reaches the cap path and escalates there.
    expect(terminal).toBe(false);
    return scope === "infra" ? new Date(NOW + INFRA_MERGE_BLOCK_TTL_MS).toISOString() : undefined;
  };

  it("persists a non-null, lapsing mergeBlockedUntil after MERGE_RETRY_CAP 429 failures", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    // Exhaust the retry budget on the same head, exactly as repeated 429 attempts would.
    for (let i = 0; i < MERGE_RETRY_CAP; i += 1) await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    const expiresAt = blockFor(httpError(429, "You have exceeded a secondary rate limit"));
    expect(expiresAt).not.toBeUndefined();
    await markPullRequestMergeBlocked(env, "alice/repo", 5, "sha-1", "merge could not complete after 5 attempt(s)", expiresAt);

    const stored = await getPullRequest(env, "alice/repo", 5);
    expect(stored?.mergeBlockedUntil).not.toBeNull();
    // The block genuinely lapses on the TTL — no new commit required.
    expect(isMergeBlockInEffect(stored!, "sha-1", NOW + INFRA_MERGE_BLOCK_TTL_MS + 1)).toBe(false);
  });

  it("keeps a 409 merge-conflict block commit-scoped (mergeBlockedUntil null), unchanged", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    // A 409 is terminal on the first failure — commit-scoped, no expiry.
    const { scope, terminal } = classifyMergeFailure(httpError(409, "Required status check is expected."));
    expect(terminal).toBe(true);
    const expiresAt = scope === "infra" ? new Date(NOW + INFRA_MERGE_BLOCK_TTL_MS).toISOString() : undefined;
    await markPullRequestMergeBlocked(env, "alice/repo", 5, "sha-1", "merge conflict (409)", expiresAt);

    expect((await getPullRequest(env, "alice/repo", 5))?.mergeBlockedUntil ?? null).toBeNull();
  });
});

// #9012 compounding bug: mergeAttemptCount's own schema and function docs promised "a new commit's attempts
// start fresh once the row's head advances", but nothing reset it — bumpPullRequestMergeAttempt only scoped the
// INCREMENT to the head. So once one head exhausted MERGE_RETRY_CAP, every later head was one-strike-terminal.
describe("the failed-merge attempt counter resets when the head advances (#9012)", () => {
  it("zeroes on a real new commit", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    expect((await getPullRequest(env, "alice/repo", 5))?.mergeAttemptCount).toBe(2);

    await upsertPullRequestFromGitHub(env, "alice/repo", { number: 5, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "sha-2" }, labels: [], body: "b" });
    expect((await getPullRequest(env, "alice/repo", 5))?.mergeAttemptCount).toBe(0);
  });

  it("does NOT zero on an ordinary resync of the same head — a genuinely failing merge keeps its bounded budget", async () => {
    const env = createTestEnv();
    await seedPr(env, "sha-1");
    await bumpPullRequestMergeAttempt(env, "alice/repo", 5, "sha-1");
    await upsertPullRequestFromGitHub(env, "alice/repo", { number: 5, title: "PR retitled", state: "open", user: { login: "bob" }, head: { sha: "sha-1" }, labels: [], body: "b" });
    expect((await getPullRequest(env, "alice/repo", 5))?.mergeAttemptCount).toBe(1);
  });
});

// #9012's "why it's silent": with review_state_label enabled, a terminally merge-blocked PR kept the
// ready-to-merge label and the block appeared on no human-visible surface at all — planner, audit and PostHog
// were the only readers of mergeBlockedReason.
describe("a terminally merge-blocked PR is labelled for review and names the reason (#9012)", () => {
  const baseInput = {
    conclusion: "success" as const,
    blockerTitles: [] as string[],
    autoMaintain: { requireApprovals: 1, mergeMethod: "squash" as const },
    slopGateMinScore: 60,
    changedPaths: [] as string[],
    hardGuardrailGlobs: [] as string[],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "passed" as const,
    autonomy: { merge: "auto" as const, review_state_label: "auto" as const },
    pr: { labels: [] as string[], mergeableState: "clean", reviewDecision: "APPROVED", headSha: "sha-1" },
  };

  function planWith(pr: Record<string, unknown>): ReturnType<typeof planAgentMaintenanceActions> {
    return planAgentMaintenanceActions({ ...baseInput, pr: { ...baseInput.pr, ...pr } } as Parameters<typeof planAgentMaintenanceActions>[0]);
  }

  it("labels ready-to-merge when nothing is blocked", () => {
    const labels = planWith({}).filter((action) => action.actionClass === "label");
    expect(labels.some((action) => action.label === AGENT_LABEL_READY && action.labelOp !== "remove")).toBe(true);
  });

  it("swaps the ready-to-merge promise for the manual-review label once the merge is terminally blocked", () => {
    const labels = planWith({ mergeBlockedSha: "sha-1", mergeBlockedReason: "merge not allowed (405)" }).filter((action) => action.actionClass === "label");
    const added = labels.filter((action) => action.labelOp !== "remove");
    expect(added.some((action) => action.label === AGENT_LABEL_READY)).toBe(false);
    expect(added.some((action) => action.label === AGENT_LABEL_NEEDS_REVIEW)).toBe(true);
    // The reason must actually reach the human — a "needs review" label with no cause is what made this silent.
    expect(added.find((action) => action.label === AGENT_LABEL_NEEDS_REVIEW)?.reason).toContain("merge not allowed (405)");
  });

  it("still names the label when the stored reason is missing, rather than emitting 'undefined'", () => {
    const labels = planWith({ mergeBlockedSha: "sha-1" }).filter((action) => action.actionClass === "label" && action.labelOp !== "remove");
    expect(labels.find((action) => action.label === AGENT_LABEL_NEEDS_REVIEW)?.reason).toContain("reason unrecorded");
  });

  it("plans no merge while blocked, and plans one once the block is gone", () => {
    expect(planWith({ mergeBlockedSha: "sha-1" }).some((action) => action.actionClass === "merge")).toBe(false);
    expect(planWith({ mergeBlockedSha: null }).some((action) => action.actionClass === "merge")).toBe(true);
  });
});
