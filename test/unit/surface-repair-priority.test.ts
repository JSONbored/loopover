import { describe, expect, it } from "vitest";
import { surfaceRepairPriorityPullNumbers } from "../../src/queue/processors";
import { recordAuditEvent, upsertCheckSummary } from "../../src/db/repositories";
import { LOOPOVER_GATE_CHECK_NAME } from "../../src/review/check-names";
import { createTestEnv } from "../helpers/d1";
import type { PullRequestRecord } from "../../src/types";

const REPO = "owner/repo";
const REGATE_REPAIR_ATTEMPT_EVENT_TYPE = "agent.sweep.regate.repair_attempt";
const REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA = 5;

function pr(overrides: Partial<PullRequestRecord> & { number: number }): PullRequestRecord {
  return {
    repoFullName: REPO,
    title: `PR ${overrides.number}`,
    state: "open",
    labels: [],
    linkedIssues: [],
    headSha: "sha1",
    ...overrides,
  };
}

async function seedCompletedGateCheck(env: Awaited<ReturnType<typeof createTestEnv>>, pullNumber: number, headSha: string, conclusion: string): Promise<void> {
  await upsertCheckSummary(env, {
    id: `${REPO}#${pullNumber}#${headSha}#gate`,
    repoFullName: REPO,
    pullNumber,
    headSha,
    name: LOOPOVER_GATE_CHECK_NAME,
    status: "completed",
    conclusion,
    payload: {},
  });
}

describe("surfaceRepairPriorityPullNumbers (#orb-stale-recheck-priority)", () => {
  it("flags a PR the bot already approved at its current head whose mergeable_state is still ambiguous (neither clean nor dirty)", async () => {
    const env = createTestEnv();
    const pulls = [pr({ number: 1, headSha: "sha1", approvedHeadSha: "sha1", mergeableState: "unstable", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([1]);
  });

  it("does NOT flag it once mergeable_state resolves to clean (nothing left to recheck)", async () => {
    const env = createTestEnv();
    const pulls = [pr({ number: 2, headSha: "sha1", approvedHeadSha: "sha1", mergeableState: "clean", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });

  it("does NOT flag it when mergeable_state is dirty (a real conflict needs a human, not a fast recheck)", async () => {
    const env = createTestEnv();
    const pulls = [pr({ number: 3, headSha: "sha1", approvedHeadSha: "sha1", mergeableState: "dirty", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });

  it("does NOT flag it when the bot's approval is for a DIFFERENT (older) commit than the current head", async () => {
    const env = createTestEnv();
    const pulls = [pr({ number: 4, headSha: "sha2", approvedHeadSha: "sha1", mergeableState: "unstable", lastPublishedSurfaceSha: "sha2" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });

  it("flags a PR with a recent self-resolving stale-recheck close/merge denial, even with a fully published, clean-looking surface", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "loopover",
      targetKey: `${REPO}#5`,
      outcome: "denied",
      detail: "duplicate-cluster winner #7437 is no longer open — action not executed",
      createdAt: new Date().toISOString(),
    });
    const pulls = [pr({ number: 5, headSha: "sha1", mergeableState: "dirty", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([5]);
  });

  it("does not resurrect a priority entry for a stale-recheck denial whose PR is no longer in the open-PR list (already closed/merged since)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "loopover",
      targetKey: `${REPO}#99`,
      outcome: "denied",
      detail: "duplicate-cluster winner #7437 is no longer open — action not executed",
      createdAt: new Date().toISOString(),
    });
    // #99 is NOT in the current open-PR list (it closed/merged since the denial was recorded) -- only an
    // unrelated PR is open this sweep.
    const pulls = [pr({ number: 100, headSha: "sha1", mergeableState: "clean", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });

  it("does NOT flag a PR whose only denial is a durable, externally-actioned reason (a manual-review label present)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.action.merge",
      actor: "loopover",
      targetKey: `${REPO}#6`,
      outcome: "denied",
      detail: 'manual-review label "manual-review" is present on the live PR — merge not executed',
      createdAt: new Date().toISOString(),
    });
    const pulls = [pr({ number: 6, headSha: "sha1", mergeableState: "clean", lastPublishedSurfaceSha: "sha1" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });

  it("still flags a missing-current-head-gate-check PR when gateCheckEnabled (pre-existing outage-repair behavior, unchanged)", async () => {
    const env = createTestEnv();
    const pulls = [pr({ number: 7, headSha: "sha1", lastPublishedSurfaceSha: "sha1", mergeableState: "clean" })];
    // No check-summary row seeded for sha1 at all -> "missing current-head gate check".

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, true)).toEqual([7]);
  });

  it("does not double-count or crash when a PR qualifies via more than one signal at once", async () => {
    const env = createTestEnv();
    await seedCompletedGateCheck(env, 8, "sha1", "success");
    const pulls = [pr({ number: 8, headSha: "sha1", approvedHeadSha: "sha1", mergeableState: "unstable", lastPublishedSurfaceSha: "different-sha" })];

    // Qualifies via BOTH the lastPublishedSurfaceSha mismatch AND the approved-but-ambiguous-mergeable signal.
    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([8]);
  });

  it("a stale-recheck-denied PR still falls back to ordinary cadence once its head SHA exhausts the shared repair-attempt cap (#orb-retry-storm)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      actor: "loopover",
      targetKey: `${REPO}#9`,
      outcome: "denied",
      detail: "the base-branch conflict that justified this close has since cleared — action not executed",
      createdAt: new Date().toISOString(),
    });
    // The SAME per-(repo, pr, headSha) attempt budget the outage-repair path already shares (isRegateRepairExhausted)
    // applies here too -- once it's exhausted for this exact head SHA, the PR drops out of the priority set even
    // though the stale-recheck-denial signal above still matches.
    for (let i = 0; i < REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA; i++) {
      await recordAuditEvent(env, {
        eventType: REGATE_REPAIR_ATTEMPT_EVENT_TYPE,
        actor: "loopover",
        targetKey: `${REPO}#9#sha1`,
        outcome: "completed",
        detail: "outage-repair re-review executing",
        createdAt: new Date().toISOString(),
      });
    }
    const pulls = [pr({ number: 9, headSha: "sha1", lastPublishedSurfaceSha: "sha1", mergeableState: "dirty" })];

    expect(await surfaceRepairPriorityPullNumbers(env, REPO, pulls, false)).toEqual([]);
  });
});
