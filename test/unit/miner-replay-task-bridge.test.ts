import { describe, expect, it } from "vitest";
import { FORWARD_REF_PLACEHOLDER } from "../../packages/loopover-miner/lib/replay-task-generation.js";
import type { ReplaySnapshot } from "../../packages/loopover-miner/lib/replay-task-bridge.js";
import {
  buildLeakageContextFromSnapshot,
  buildReplayCandidateFromSnapshot,
  collectFrozenContextTexts,
  generateLeakageSafeReplayTask,
  generateLeakageSafeScoringKey,
} from "../../packages/loopover-miner/lib/replay-task-bridge.js";

// The bridge is deliberately defensive about malformed snapshot fields (null entries, non-string subjects/names,
// non-array collections) a corrupted store row could carry; this coerces such intentionally-off-shape fixtures
// past the strict declared type so those runtime branches can be exercised directly.
const malformed = (value: unknown): ReplaySnapshot => value as ReplaySnapshot;

// A well-formed #3010 snapshot as `exportReplaySnapshot` produces it: full ancestry up to T (real 40-hex SHAs),
// reachable annotated tags, README-at-T. Issues 1..100 and these commits existed at T; issue 300 is post-T.
const PRE_T_SHA_A = "a".repeat(40);
const PRE_T_SHA_B = "b".repeat(40);

const snapshot = {
  repoFullName: "o/r",
  commitSha: PRE_T_SHA_A,
  worktreePath: "/tmp/.loopover-replay-snapshots/aaaa",
  targetDate: "2026-01-10T00:00:00Z",
  commits: [
    { sha: PRE_T_SHA_A, date: "2026-01-10T00:00:00Z", subject: "feat: freeze point" },
    { sha: PRE_T_SHA_B, date: "2026-01-09T00:00:00Z", subject: "chore: earlier work" },
  ],
  tags: [{ name: "v1.0.0", date: "2026-01-10T00:00:00Z", targetSha: PRE_T_SHA_A }],
  readme: { filename: "README.md", content: "A calm project readme with no leaks." },
  exportedAt: "2026-01-11T00:00:00Z",
};

const issueContext = { knownIssueMax: 100, revealedIssueNumbers: [300] };

describe("loopover-miner replay-task bridge (#6160)", () => {
  describe("collectFrozenContextTexts", () => {
    it("gathers README-at-T, then commit subjects, then tag names in a fixed order", () => {
      expect(collectFrozenContextTexts(snapshot)).toEqual([
        "A calm project readme with no leaks.",
        "feat: freeze point",
        "chore: earlier work",
        "v1.0.0",
      ]);
    });

    it("skips a null README, empty/non-string subjects, and empty/non-string tag names", () => {
      const sparse = malformed({
        readme: null,
        commits: [null, { sha: PRE_T_SHA_A, subject: "" }, { subject: 42 }, { subject: "kept subject" }],
        tags: [null, { name: "" }, { name: 7 }, { name: "kept-tag" }],
      });
      expect(collectFrozenContextTexts(sparse)).toEqual(["kept subject", "kept-tag"]);
    });

    it("skips an empty-string README and tolerates non-array commits/tags", () => {
      expect(collectFrozenContextTexts(malformed({ readme: { content: "" }, commits: null, tags: undefined }))).toEqual(
        [],
      );
    });

    it("throws on a snapshot that is not a plain object", () => {
      expect(() => collectFrozenContextTexts(malformed(null))).toThrow("invalid_replay_snapshot");
      expect(() => collectFrozenContextTexts(malformed(42))).toThrow("invalid_replay_snapshot");
      expect(() => collectFrozenContextTexts(malformed([]))).toThrow("invalid_replay_snapshot");
    });
  });

  describe("buildLeakageContextFromSnapshot", () => {
    it("derives the pre-T commit SHAs from the snapshot and passes issue knowledge through", () => {
      expect(buildLeakageContextFromSnapshot(snapshot, issueContext)).toEqual({
        knownIssueMax: 100,
        knownCommitShas: [PRE_T_SHA_A, PRE_T_SHA_B],
        revealedIssueNumbers: [300],
      });
    });

    it("defaults issue knowledge to undefined and tolerates a malformed commit entry", () => {
      expect(buildLeakageContextFromSnapshot(malformed({ commits: [null, { sha: PRE_T_SHA_A }] }))).toEqual({
        knownIssueMax: undefined,
        knownCommitShas: [undefined, PRE_T_SHA_A],
        revealedIssueNumbers: undefined,
      });
    });
  });

  describe("buildReplayCandidateFromSnapshot", () => {
    it("maps the snapshot fields and the revealed post-T side onto a freeze-point candidate", () => {
      expect(
        buildReplayCandidateFromSnapshot(snapshot, { revealedCommitCount: 4, revealedGroundTruth: { merged: true } }),
      ).toEqual({
        repo: "o/r",
        commitT: PRE_T_SHA_A,
        lastActivityAt: "2026-01-10T00:00:00Z",
        priorCommitCount: 2,
        revealedCommitCount: 4,
        revealedGroundTruth: { merged: true },
        frozenContextTexts: [
          "A calm project readme with no leaks.",
          "feat: freeze point",
          "chore: earlier work",
          "v1.0.0",
        ],
      });
    });

    it("nulls out non-string identity fields and defaults the revealed side", () => {
      expect(buildReplayCandidateFromSnapshot(malformed({ repoFullName: 5, commitSha: null }))).toEqual({
        repo: null,
        commitT: null,
        lastActivityAt: null,
        priorCommitCount: 0,
        revealedCommitCount: undefined,
        revealedGroundTruth: undefined,
        frozenContextTexts: [],
      });
    });
  });

  describe("generateLeakageSafeReplayTask (the wiring)", () => {
    it("freezes a clean snapshot into a leakage-safe task, tagging its recency pool", () => {
      const task = generateLeakageSafeReplayTask(
        snapshot,
        { revealedCommitCount: 3 },
        issueContext,
        { modelCutoffIso: "2026-01-01T00:00:00Z" },
      );
      if (!task.eligible) throw new Error(`expected eligible task, got ${JSON.stringify(task)}`);
      expect(task.pool).toBe("recent"); // lastActivityAt (2026-01-10) >= modelCutoff (2026-01-01)
      expect(task.frozen).toEqual({
        repo: "o/r",
        commitT: PRE_T_SHA_A,
        contextTexts: [
          "A calm project readme with no leaks.",
          "feat: freeze point",
          "chore: earlier work",
          "v1.0.0",
        ],
      });
      expect(task).not.toHaveProperty("revealed"); // post-T ground truth is never in the frozen task
    });

    // REGRESSION (#6160, deliverable #2): a genuine forward-reference leak in a snapshot's own free-text context
    // is caught end-to-end by the wired-in pipeline -- not merely by the standalone functions in isolation. A
    // commit subject / README that names a scrubbable post-T reference is redacted before the task is frozen.
    it("scrubs scrubbable post-T references (a #ref, a deep-link, and an unknown SHA) out of the frozen task", () => {
      const leaky = {
        ...snapshot,
        readme: { filename: "README.md", content: "see the follow-up in deadbeefcafe for details" },
        commits: [
          { sha: PRE_T_SHA_A, subject: "feat: prep for #300 per https://github.com/o/r/pull/450" },
          { sha: PRE_T_SHA_B, subject: "chore: earlier work" },
        ],
      };
      const task = generateLeakageSafeReplayTask(leaky, { revealedCommitCount: 3 }, { knownIssueMax: 100 });
      if (!task.eligible) throw new Error(`expected eligible task, got ${JSON.stringify(task)}`);
      const joined = task.frozen.contextTexts.join("\n");
      expect(joined).not.toContain("#300");
      expect(joined).not.toContain("https://github.com/o/r/pull/450");
      expect(joined).not.toContain("deadbeefcafe");
      expect(joined).toContain(FORWARD_REF_PLACEHOLDER);
      // The snapshot's OWN pre-T commit SHAs are derived as known context and must survive untouched.
      expect(task.frozen.contextTexts).toContain("chore: earlier work");
    });

    // REGRESSION (#6160): a bare integer that names a real post-T issue cannot be safely auto-scrubbed, so the
    // wired-in lint pass must REJECT the whole freeze point rather than silently freeze a leaky task.
    it("rejects a freeze point whose context leaks an unscrubbable bare post-T issue number", () => {
      const leaky = {
        ...snapshot,
        readme: { filename: "README.md", content: "the open-ticket tally reached 300 this sprint" },
      };
      expect(generateLeakageSafeReplayTask(leaky, { revealedCommitCount: 3 }, issueContext)).toEqual({
        eligible: false,
        rejected: "unscrubbable_forward_reference",
        residual: [{ kind: "bare-issue-number", value: 300 }],
      });
    });

    it("rejects a freeze point without enough history on both sides, without scrubbing", () => {
      expect(
        generateLeakageSafeReplayTask(snapshot, { revealedCommitCount: 1 }, issueContext, {
          thresholds: { minPriorCommits: 5, minRevealedCommits: 5 },
        }),
      ).toEqual({
        eligible: false,
        rejected: "selection",
        reasons: ["insufficient_prior_history", "insufficient_revealed_history"],
      });
    });

    it("applies default revealed/context/options arguments when omitted", () => {
      const task = generateLeakageSafeReplayTask(snapshot);
      if (!task.eligible) throw new Error(`expected eligible task, got ${JSON.stringify(task)}`);
      expect(task.pool).toBe("older"); // no modelCutoff supplied -> unknown recency defaults to older
      expect(task.frozen.repo).toBe("o/r");
    });
  });

  describe("generateLeakageSafeScoringKey", () => {
    it("returns the isolated scoring key without any frozen context", () => {
      const key = generateLeakageSafeScoringKey(snapshot, {
        revealedCommitCount: 4,
        revealedGroundTruth: { merged: true },
      });
      expect(key).toEqual({ eligible: true, commitCount: 4, groundTruth: { merged: true } });
      expect(key).not.toHaveProperty("frozen");
    });

    it("defaults groundTruth to null and options to {} when omitted", () => {
      expect(generateLeakageSafeScoringKey(snapshot, { revealedCommitCount: 2 })).toEqual({
        eligible: true,
        commitCount: 2,
        groundTruth: null,
      });
    });

    it("rejects a scoring key for a snapshot that fails selection under supplied thresholds", () => {
      expect(
        generateLeakageSafeScoringKey(snapshot, { revealedCommitCount: 1 }, {
          thresholds: { minPriorCommits: 5, minRevealedCommits: 5 },
        }),
      ).toEqual({
        eligible: false,
        rejected: "selection",
        reasons: ["insufficient_prior_history", "insufficient_revealed_history"],
      });
    });

    // Pins the documented eligibility asymmetry: the scoring key only checks selection, so a snapshot whose
    // context generateLeakageSafeReplayTask rejects as unscrubbable STILL yields a scoring key here. Callers must
    // check the task result independently before treating the two as a matched pair.
    it("still yields a scoring key for a snapshot whose task is rejected as unscrubbable", () => {
      const leaky = {
        ...snapshot,
        readme: { filename: "README.md", content: "the open-ticket tally reached 300 this sprint" },
      };
      const task = generateLeakageSafeReplayTask(leaky, { revealedCommitCount: 3 }, issueContext);
      expect(task).toMatchObject({ eligible: false, rejected: "unscrubbable_forward_reference" });

      expect(
        generateLeakageSafeScoringKey(leaky, { revealedCommitCount: 3, revealedGroundTruth: { merged: false } }),
      ).toEqual({ eligible: true, commitCount: 3, groundTruth: { merged: false } });
    });
  });
});
