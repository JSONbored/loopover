import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { repositories } from "../../src/db/schema";
import { upsertRepositorySettings } from "../../src/db/repositories";
import {
  dupWinnerLinkedDuplicateCount,
  dupWinnerLinkedDuplicateWinnerNumber,
  linkedIssueDuplicatePullRequestRecordsForGate,
} from "../../src/queue/duplicate-detection";
import { gateCheckPolicy } from "../../src/queue/processors";
import { buildPullRequestAdvisory, evaluateGateCheck } from "../../src/rules/advisory";
import { AGENT_LABEL_NEEDS_REVIEW, planAgentMaintenanceActions, type AgentActionPlanInput } from "../../src/settings/agent-actions";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import type { PullRequestRecord, RepositoryRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

/**
 * #9033 CENTERPIECE REGRESSION: the confirmed reward-farming scenario -- two colluding accounts (or one
 * attacker with two identities) file near-identical fixes under DIFFERENT linked issues on a reward-eligible
 * (subnet-registered) repo. Before this fix:
 *   1. copycatGateMode defaulted to "off" for every repo, so the containment engine never ran and never
 *      persisted a score/match at all unless the repo explicitly opted in via .loopover.yml.
 *   2. Even with a persisted match, the duplicate-cluster election and the duplicate_pr_risk gate finding both
 *      keyed ENTIRELY on shared linkedIssues overlap, so a cross-issue match was invisible to both.
 * Result: the second PR merged independently and both earned rewards for one piece of work.
 *
 * This test exercises the full chain end-to-end: reward-eligible settings resolution -> the duplicate-cluster
 * helpers -> the gate advisory/finding -> the actual close/merge disposition -- proving the loser is held/closed
 * as a duplicate instead of merging independently, while the winner is untouched and still merges on its own
 * merits.
 */
async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/") as [string, string];
  await getDb(env.DB)
    .insert(repositories)
    .values({ fullName, owner, name, isRegistered: true });
}

describe("#9033 cross-issue copycat reward-farming regression", () => {
  it("holds/closes the later cross-issue copycat PR as a duplicate while the earlier claimant merges untouched", async () => {
    const env = createTestEnv();
    const repoFullName = "acme/reward-eligible-repo";
    await seedRegisteredRepo(env, repoFullName);
    await upsertRepositorySettings(env, { repoFullName });

    // The repo never configured gate.copycat.mode in .loopover.yml -- reward-eligibility alone must turn the
    // containment engine on, and duplicatePrGateMode's own DB-layer default is already "block".
    const settings = await resolveRepositorySettings(env, repoFullName);
    expect(settings.copycatGateMode).toBe("warn");
    expect(settings.duplicatePrGateMode).toBe("block");

    const repo: RepositoryRecord = {
      fullName: repoFullName,
      owner: "acme",
      name: "reward-eligible-repo",
      isInstalled: true,
      isRegistered: true,
      isPrivate: false,
    };

    // PR #10 claims issue #1 first; PR #11 claims a DIFFERENT issue (#2) later, with near-identical added code.
    // copycatScore/copycatMatchedPullNumber on #11 simulate what runCopycatAssessment already computed and
    // persisted during #11's own gate evaluation (copycat-detection.ts's own responsibility, exercised
    // separately in copycat-detection.test.ts) -- this test picks up from that persisted verdict.
    const winner: PullRequestRecord = {
      repoFullName,
      number: 10,
      title: "Fix the rate limiter",
      state: "open",
      authorLogin: "account-one",
      authorAssociation: "NONE",
      headSha: "sha-10",
      labels: [],
      linkedIssues: [1],
      linkedIssueClaimedAt: "2026-07-20T10:00:00.000Z",
      createdAt: "2026-07-20T10:00:00.000Z",
    };
    const loser: PullRequestRecord = {
      repoFullName,
      number: 11,
      title: "Patch the throttling bug",
      state: "open",
      authorLogin: "account-two",
      authorAssociation: "NONE",
      headSha: "sha-11",
      labels: [],
      linkedIssues: [2], // a DIFFERENT linked issue than #10 -- the exact evasion this issue describes
      linkedIssueClaimedAt: "2026-07-20T11:00:00.000Z", // claimed an hour LATER
      createdAt: "2026-07-20T11:00:00.000Z",
      copycatScore: 96,
      copycatMatchedPullNumber: 10, // the containment engine already named #10 as the earlier original
    };

    // --- Duplicate-cluster helpers now see the cross-issue match ---
    const loserSiblings = linkedIssueDuplicatePullRequestRecordsForGate(loser, [winner], settings.copycatGateMode, settings.copycatGateMinScore);
    expect(loserSiblings.map((p) => p.number)).toEqual([10]);
    expect(dupWinnerLinkedDuplicateCount(loserSiblings, loser.number, loser.linkedIssueClaimedAt, true, loser.createdAt)).toBe(1);
    expect(dupWinnerLinkedDuplicateWinnerNumber(loserSiblings, loser.number, loser.linkedIssueClaimedAt, true, loser.createdAt)).toBe(10);

    const winnerSiblings = linkedIssueDuplicatePullRequestRecordsForGate(winner, [loser], settings.copycatGateMode, settings.copycatGateMinScore);
    // #10 has no persisted copycat match of its own (it's the original, never accused of copying #11) and no
    // shared linked issue with #11 -- so #10 sees no duplicate-cluster sibling at all.
    expect(winnerSiblings).toEqual([]);
    expect(dupWinnerLinkedDuplicateCount(winnerSiblings, winner.number, winner.linkedIssueClaimedAt, true, winner.createdAt)).toBe(0);

    // --- The gate finding itself: #11 (the loser) fails on duplicate_pr_risk; #10 (the winner) does not ---
    const loserAdvisory = buildPullRequestAdvisory(repo, loser, {
      otherOpenPullRequests: [winner],
      duplicateWinnerEnabled: true,
      copycatGateMode: settings.copycatGateMode,
      copycatGateMinScore: settings.copycatGateMinScore,
    });
    expect(loserAdvisory.findings.map((f) => f.code)).toContain("duplicate_pr_risk");
    const loserGate = evaluateGateCheck(loserAdvisory, gateCheckPolicy(settings));
    // #9129: a gate that fails SOLELY on a (even corroborated) duplicate_pr_risk finding is downgraded to a
    // NEUTRAL hold, never an outright close -- this is the SAME precision-safe treatment a genuine same-issue
    // duplicate already gets today (a rival PR's own claim can never unilaterally force a close), and #9033's
    // cross-issue copycat match now goes through this identical mechanism instead of bypassing it entirely.
    expect(loserGate.conclusion).toBe("neutral");
    expect(loserGate.warnings.map((w) => w.code)).toContain("duplicate_pr_risk");

    const winnerAdvisory = buildPullRequestAdvisory(repo, winner, {
      otherOpenPullRequests: [loser],
      duplicateWinnerEnabled: true,
      copycatGateMode: settings.copycatGateMode,
      copycatGateMinScore: settings.copycatGateMinScore,
    });
    expect(winnerAdvisory.findings.map((f) => f.code)).not.toContain("duplicate_pr_risk");
    const winnerGate = evaluateGateCheck(winnerAdvisory, gateCheckPolicy(settings));
    expect(winnerGate.conclusion).toBe("success");

    // --- The actual disposition: the loser is HELD for manual review instead of merging independently; the
    // winner MERGES on its own merits, untouched. ---
    function planInput(overrides: Partial<AgentActionPlanInput> & Pick<AgentActionPlanInput, "conclusion" | "blockerTitles">): AgentActionPlanInput {
      return {
        autonomy: { merge: "auto", close: "auto", review_state_label: "auto" },
        autoMaintain: { requireApprovals: 0, mergeMethod: "squash" },
        slopGateMinScore: 60,
        changedPaths: [],
        hardGuardrailGlobs: [],
        authorIsOwner: false,
        authorIsAdmin: false,
        authorIsAutomationBot: false,
        ciState: "passed",
        pr: { labels: [], mergeableState: "clean" },
        ...overrides,
      };
    }

    const loserPlan = planAgentMaintenanceActions(
      planInput({
        conclusion: loserGate.conclusion,
        blockerTitles: [],
        pr: {
          labels: [],
          mergeableState: "clean",
          linkedDuplicateCount: dupWinnerLinkedDuplicateCount(loserSiblings, loser.number, loser.linkedIssueClaimedAt, true, loser.createdAt),
          linkedDuplicateWinnerNumber: dupWinnerLinkedDuplicateWinnerNumber(loserSiblings, loser.number, loser.linkedIssueClaimedAt, true, loser.createdAt),
        },
      }),
    );
    // The core claim: the loser does NOT merge independently, and is not silently left undecided either -- it is
    // held with a manual-review label so a maintainer triages the cross-issue race, exactly like a same-issue race.
    expect(loserPlan.some((action) => action.actionClass === "merge")).toBe(false);
    expect(loserPlan.some((action) => action.actionClass === "close")).toBe(false);
    const loserHold = loserPlan.find((action) => action.actionClass === "label" && action.label === AGENT_LABEL_NEEDS_REVIEW);
    expect(loserHold).toBeDefined();
    expect(loserHold?.reason).toContain("verdict=neutral");

    const winnerPlan = planAgentMaintenanceActions(
      planInput({
        conclusion: "success",
        blockerTitles: [],
        pr: { labels: [], mergeableState: "clean" },
      }),
    );
    expect(winnerPlan.some((action) => action.actionClass === "merge")).toBe(true);
    expect(winnerPlan.some((action) => action.actionClass === "close")).toBe(false);
  });
});
