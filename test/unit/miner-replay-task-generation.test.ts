import { describe, expect, it } from "vitest";
import {
  FORWARD_REF_PLACEHOLDER,
  RECENCY_POOLS,
  classifyRecencyPool,
  detectForwardReferences,
  generateReplayTask,
  lintFrozenContext,
  scrubForwardReferences,
  selectFreezePoint,
} from "../../packages/gittensory-miner/lib/replay-task-generation.js";

// Issues 1..100 and one commit SHA existed at T; issues 250/300 are revealed post-T ground truth.
const CONTEXT = {
  knownIssueMax: 100,
  knownCommitShas: ["abc1234def"],
  revealedIssueNumbers: [250, 300],
};

describe("gittensory-miner leakage-safe replay task generation (#3011)", () => {
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

    it("produces a scrubbed frozen bundle and a SEPARATE revealed bundle for an eligible clean point", () => {
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
      // Ground truth lives only on the revealed side — never merged into the frozen bundle.
      expect(task.revealed).toEqual({ commitCount: 10, groundTruth: { merged: true, approach: "refactor" } });
      expect(task.frozen).not.toHaveProperty("groundTruth");
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
  });
});
