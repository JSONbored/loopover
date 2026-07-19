import { describe, expect, it } from "vitest";
import {
  FORWARD_REF_PLACEHOLDER,
  RECENCY_POOLS,
  classifyRecencyPool,
  detectForwardReferences,
  generateReplayScoringKey,
  generateReplayTask,
  lintFrozenContext,
  scrubForwardReferences,
  selectFreezePoint,
} from "../../packages/loopover-miner/lib/replay-task-generation.js";

// Issues 1..100 and one commit SHA existed at T; issues 250/300 are revealed post-T ground truth.
const CONTEXT = {
  knownIssueMax: 100,
  knownCommitShas: ["abc1234def"],
  revealedIssueNumbers: [250, 300],
};

describe("loopover-miner leakage-safe replay task generation (#3011)", () => {
  it("exposes a frozen recency-pool vocabulary and a stable placeholder", () => {
    expect(Object.isFrozen(RECENCY_POOLS)).toBe(true);
    expect(RECENCY_POOLS).toEqual(["recent", "older"]);
    expect(FORWARD_REF_PLACEHOLDER).toBe("[redacted-forward-ref]");
  });

  describe("detectForwardReferences", () => {
    it("flags post-T #refs, deep-links, and unknown SHAs as scrubbable; keeps pre-T ones", () => {
      const { scrubbable, unscrubbable } = detectForwardReferences(
        "closes #300 (see https://github.com/o/r/pull/250) unlike old #42 at abc1234def then c0ffee99",
        CONTEXT,
      );
      const values = scrubbable.map((ref) => ref.value);
      expect(values).toContain("#300"); // > knownIssueMax
      expect(values).toContain("https://github.com/o/r/pull/250"); // deep-link > max
      expect(values).toContain("c0ffee99"); // unknown SHA
      expect(values).not.toContain("#42"); // <= knownIssueMax, pre-T
      expect(scrubbable.some((ref) => ref.value === "abc1234def")).toBe(false); // known pre-T SHA kept
      expect(unscrubbable).toEqual([]);
    });

    it("flags a bare integer that names a real post-T issue as unscrubbable", () => {
      const { scrubbable, unscrubbable } = detectForwardReferences("the tally reached 300 last week", CONTEXT);
      expect(scrubbable).toEqual([]);
      expect(unscrubbable).toEqual([{ kind: "bare-issue-number", value: 300 }]);
    });

    it("does not misread a plain decimal number as a SHA", () => {
      // 12345678 is 8 digits, in [0-9a-f] range, but has no hex letter → it is a number, not a hash.
      const { scrubbable } = detectForwardReferences("build 12345678 shipped", { knownCommitShas: [] });
      expect(scrubbable).toEqual([]);
    });

    it("scrubs a commit deep-link whose SHA is not in pre-T history, but keeps one that is", () => {
      const { scrubbable } = detectForwardReferences(
        `see https://github.com/o/r/commit/deadbeef01 and https://github.com/o/r/commit/abc1234def`,
        CONTEXT,
      );
      const values = scrubbable.map((ref) => ref.value);
      expect(values).toContain("https://github.com/o/r/commit/deadbeef01");
      expect(values).not.toContain("https://github.com/o/r/commit/abc1234def"); // known pre-T SHA kept
    });

    it("ignores a non-integer/negative revealedIssueNumbers entry and a non-string knownCommitShas entry", () => {
      const garbageContext = {
        knownIssueMax: 100,
        knownCommitShas: [42, "abc1234def"] as unknown as string[],
        revealedIssueNumbers: [-5, 1.5, 300],
      };
      const { unscrubbable } = detectForwardReferences("still 300 leaks, -5 and 1.5 do not count", garbageContext);
      expect(unscrubbable).toEqual([{ kind: "bare-issue-number", value: 300 }]);
    });

    it("treats a non-array knownCommitShas as no known SHAs, without throwing", () => {
      const { scrubbable } = detectForwardReferences("see c0ffee99", { knownCommitShas: "not-an-array" as unknown as string[] });
      expect(scrubbable.map((ref) => ref.value)).toContain("c0ffee99");
    });

    it("keeps a pre-T issue/pull deep-link untouched", () => {
      const { scrubbable } = detectForwardReferences("see https://github.com/o/r/issues/42", CONTEXT);
      expect(scrubbable).toEqual([]);
    });
  });

  describe("scrubForwardReferences", () => {
    it("replaces every scrubbable forward reference with the placeholder and reports them", () => {
      const result = scrubForwardReferences(
        "fixed #300 via https://github.com/o/r/pull/250 in deadc0de",
        { knownIssueMax: 100, knownCommitShas: [], revealedIssueNumbers: [] },
      );
      expect(result.scrubbed).toBe(
        `fixed ${FORWARD_REF_PLACEHOLDER} via ${FORWARD_REF_PLACEHOLDER} in ${FORWARD_REF_PLACEHOLDER}`,
      );
      expect(result.removed).toHaveLength(3);
      expect(result.residual).toEqual([]);
    });

    it("leaves an unscrubbable bare issue number in place and surfaces it as residual", () => {
      const result = scrubForwardReferences("the number 300 leaked here", CONTEXT);
      expect(result.scrubbed).toBe("the number 300 leaked here"); // unchanged — cannot safely remove a bare int
      expect(result.removed).toEqual([]);
      expect(result.residual).toEqual([{ kind: "bare-issue-number", value: 300 }]);
    });

    it("leaves pre-T references untouched", () => {
      const result = scrubForwardReferences("see #42 at abc1234def", CONTEXT);
      expect(result.scrubbed).toBe("see #42 at abc1234def");
      expect(result.removed).toEqual([]);
    });

    it("coerces a non-string input to an empty scrub", () => {
      expect(scrubForwardReferences(null, CONTEXT)).toEqual({ scrubbed: "", removed: [], residual: [] });
    });
  });

  describe("lintFrozenContext", () => {
    it("passes when every text scrubs to zero residual forward references", () => {
      const lint = lintFrozenContext(["closes #300", "see https://github.com/o/r/issues/250"], CONTEXT);
      expect(lint).toEqual({ ok: true, residual: [] });
    });

    it("fails when any text carries an unscrubbable forward reference", () => {
      const lint = lintFrozenContext(["harmless #42", "leaks 250 in prose"], CONTEXT);
      expect(lint.ok).toBe(false);
      expect(lint.residual).toEqual([{ kind: "bare-issue-number", value: 250 }]);
    });

    it("treats a null/undefined texts input as an empty list, and wraps a single non-array text", () => {
      expect(lintFrozenContext(null, CONTEXT)).toEqual({ ok: true, residual: [] });
      expect(lintFrozenContext(undefined, CONTEXT)).toEqual({ ok: true, residual: [] });
      const lint = lintFrozenContext("leaks 250 in prose", CONTEXT);
      expect(lint.ok).toBe(false);
      expect(lint.residual).toEqual([{ kind: "bare-issue-number", value: 250 }]);
    });
  });

  describe("selectFreezePoint", () => {
    it("is eligible only when prior and revealed history both clear the thresholds", () => {
      const ok = selectFreezePoint(
        { priorCommitCount: 50, revealedCommitCount: 10 },
        { minPriorCommits: 10, minRevealedCommits: 5 },
      );
      expect(ok).toEqual({ eligible: true, reasons: [], priorCommitCount: 50, revealedCommitCount: 10 });
    });

    it("reports each unmet threshold and defaults missing counts to 0", () => {
      const result = selectFreezePoint({}, { minPriorCommits: 10, minRevealedCommits: 5 });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toEqual(["insufficient_prior_history", "insufficient_revealed_history"]);
    });
  });

  describe("classifyRecencyPool", () => {
    it("splits at the model cutoff and defaults unknown dates to 'older'", () => {
      const opts = { modelCutoffIso: "2026-01-01T00:00:00Z" };
      expect(classifyRecencyPool({ lastActivityAt: "2026-06-01T00:00:00Z" }, opts)).toBe("recent");
      expect(classifyRecencyPool({ lastActivityAt: "2025-06-01T00:00:00Z" }, opts)).toBe("older");
      expect(classifyRecencyPool({ lastActivityAt: "2026-01-01T00:00:00Z" }, opts)).toBe("recent"); // boundary
      expect(classifyRecencyPool({}, opts)).toBe("older"); // unknown activity date
      expect(classifyRecencyPool({ lastActivityAt: "2026-06-01T00:00:00Z" }, {})).toBe("older"); // no cutoff
    });
  });

  describe("generateReplayTask", () => {
    const eligible = {
      repo: "o/r",
      commitT: "abc1234def",
      priorCommitCount: 50,
      revealedCommitCount: 10,
      lastActivityAt: "2026-06-01T00:00:00Z",
      revealedGroundTruth: { merged: true, approach: "refactor" },
    };
    const options = {
      thresholds: { minPriorCommits: 10, minRevealedCommits: 5 },
      modelCutoffIso: "2026-01-01T00:00:00Z",
    };

    it("produces only a scrubbed frozen bundle for an eligible clean point", () => {
      const task = generateReplayTask(
        { ...eligible, frozenContextTexts: ["intro references #300 and old #12"] },
        CONTEXT,
        options,
      );
      if (!task.eligible) throw new Error(`expected eligible task, got ${JSON.stringify(task)}`);
      expect(task.pool).toBe("recent");
      expect(task.frozen).toEqual({
        repo: "o/r",
        commitT: "abc1234def",
        contextTexts: [`intro references ${FORWARD_REF_PLACEHOLDER} and old #12`],
      });
      expect(task).not.toHaveProperty("revealed");
      expect(JSON.stringify(task)).not.toContain("refactor");
      expect(task.frozen).not.toHaveProperty("groundTruth");
    });

    it("defaults a missing frozenContextTexts to an empty list and missing repo/commitT to null", () => {
      const { repo: _omitRepo, commitT: _omitCommitT, ...rest } = eligible;
      const task = generateReplayTask(rest, CONTEXT, options);
      if (!task.eligible) throw new Error(`expected eligible task, got ${JSON.stringify(task)}`);
      expect(task.frozen).toEqual({ repo: null, commitT: null, contextTexts: [] });
    });

    it("rejects a candidate that fails selection, without scrubbing", () => {
      const task = generateReplayTask(
        { priorCommitCount: 2, revealedCommitCount: 1, frozenContextTexts: ["#300"] },
        CONTEXT,
        options,
      );
      expect(task).toEqual({
        eligible: false,
        rejected: "selection",
        reasons: ["insufficient_prior_history", "insufficient_revealed_history"],
      });
    });

    it("rejects a candidate whose frozen context has an unscrubbable forward reference", () => {
      const task = generateReplayTask(
        { ...eligible, frozenContextTexts: ["the tally hit 250 last month"] },
        CONTEXT,
        options,
      );
      expect(task).toEqual({
        eligible: false,
        rejected: "unscrubbable_forward_reference",
        residual: [{ kind: "bare-issue-number", value: 250 }],
      });
    });

    it("is deterministic across repeated runs on identical inputs", () => {
      const input = { ...eligible, frozenContextTexts: ["closes #300, keeps #7"] };
      expect(generateReplayTask(input, CONTEXT, options)).toEqual(
        generateReplayTask(input, CONTEXT, options),
      );
    });

    it("exposes revealed ground truth only through the scoring-only accessor", () => {
      const replayTask = generateReplayTask(
        { ...eligible, frozenContextTexts: ["intro references #300"] },
        CONTEXT,
        options,
      );
      const scoringKey = generateReplayScoringKey(
        { ...eligible, frozenContextTexts: ["intro references #300"] },
        options,
      );

      if (!replayTask.eligible) {
        throw new Error(`expected eligible replay task, got ${JSON.stringify(replayTask)}`);
      }
      if (!scoringKey.eligible) {
        throw new Error(`expected eligible scoring key, got ${JSON.stringify(scoringKey)}`);
      }
      expect(replayTask).not.toHaveProperty("revealed");
      expect(scoringKey).toEqual({
        commitCount: 10,
        eligible: true,
        groundTruth: { merged: true, approach: "refactor" },
      });
      expect(scoringKey).not.toHaveProperty("frozen");
    });

    it("rejects a scoring key for a candidate that fails selection", () => {
      expect(generateReplayScoringKey({ priorCommitCount: 2, revealedCommitCount: 1 }, options)).toEqual({
        eligible: false,
        rejected: "selection",
        reasons: ["insufficient_prior_history", "insufficient_revealed_history"],
      });
    });

    // REGRESSION: pins the intentional eligibility asymmetry documented on generateReplayScoringKey itself --
    // it never lints/scrubs frozen context, so a candidate generateReplayTask rejects for an unscrubbable
    // forward reference still yields a scoring key here. A caller must not assume the two are a matched pair
    // without checking generateReplayTask's own result (see the same candidate's rejection above).
    it("still returns a scoring key for a candidate whose frozen context generateReplayTask rejects as unscrubbable", () => {
      const candidate = { ...eligible, frozenContextTexts: ["the tally hit 250 last month"] };

      const replayTask = generateReplayTask(candidate, CONTEXT, options);
      expect(replayTask).toEqual({
        eligible: false,
        rejected: "unscrubbable_forward_reference",
        residual: [{ kind: "bare-issue-number", value: 250 }],
      });

      const scoringKey = generateReplayScoringKey(candidate, options);
      expect(scoringKey).toEqual({
        eligible: true,
        commitCount: 10,
        groundTruth: { merged: true, approach: "refactor" },
      });
    });
  });
});
