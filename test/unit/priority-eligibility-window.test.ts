// The priority-issue eligibility window (#9738).
//
// Every branch of the evaluator, both sides of every fallback: the rule holds a PR only when it can prove
// the PR arrived inside the window, and opens for everything else.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIORITY_ELIGIBILITY_WINDOW_MINUTES,
  MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES,
  MIN_PRIORITY_ELIGIBILITY_WINDOW_MINUTES,
  PRIORITY_ELIGIBILITY_RULE_ID,
  evaluatePriorityEligibilityWindow,
  priorityEligibleAt,
  resolvePriorityEligibilityHold,
} from "../../src/review/priority-eligibility-window";

const LABELED_AT = "2026-07-29T12:00:00.000Z";
/** The default window's boundary, to the millisecond. */
const ELIGIBLE_AT = "2026-07-29T12:30:00.000Z";

describe("priority eligibility window (#9738)", () => {
  it("holds a PR opened inside the window, naming the moment it becomes eligible", () => {
    const result = evaluatePriorityEligibilityWindow({
      windowMinutes: DEFAULT_PRIORITY_ELIGIBILITY_WINDOW_MINUTES,
      labeledAt: LABELED_AT,
      prCreatedAt: "2026-07-29T12:00:30.000Z",
    });
    expect(result.eligible).toBe(false);
    expect(result.eligibleAt).toBe(ELIGIBLE_AT);
    // The comment a contributor reads must say it is a wait, not a rejection.
    expect(result.reason).toContain(ELIGIBLE_AT);
    expect(result.reason).toContain("continues normally");
    expect(result.reason).not.toMatch(/reject|closed|violation/i);
  });

  it("opens exactly AT the boundary, not one millisecond later", () => {
    // An off-by-one here is a PR held for a window that has provably elapsed.
    expect(evaluatePriorityEligibilityWindow({ windowMinutes: 30, labeledAt: LABELED_AT, prCreatedAt: ELIGIBLE_AT }).eligible).toBe(true);
    expect(
      evaluatePriorityEligibilityWindow({ windowMinutes: 30, labeledAt: LABELED_AT, prCreatedAt: "2026-07-29T12:29:59.999Z" }).eligible,
    ).toBe(false);
  });

  it("leaves a PR opened after the window untouched", () => {
    const result = evaluatePriorityEligibilityWindow({ windowMinutes: 30, labeledAt: LABELED_AT, prCreatedAt: "2026-07-29T13:00:00.000Z" });
    expect(result).toEqual({ eligible: true, reason: null, eligibleAt: null });
  });

  it("is off when the window is zero or negative", () => {
    for (const windowMinutes of [0, -1, -30]) {
      expect(evaluatePriorityEligibilityWindow({ windowMinutes, labeledAt: LABELED_AT, prCreatedAt: LABELED_AT }).eligible).toBe(true);
    }
  });

  it("FAILS OPEN when a timestamp is missing or unreadable", () => {
    // Holding someone's PR because WE could not read a timestamp is a penalty for our own gap.
    const cases = [
      { labeledAt: null, prCreatedAt: LABELED_AT },
      { labeledAt: LABELED_AT, prCreatedAt: null },
      { labeledAt: "not-a-date", prCreatedAt: LABELED_AT },
      { labeledAt: LABELED_AT, prCreatedAt: "not-a-date" },
      { labeledAt: "", prCreatedAt: "" },
    ];
    for (const { labeledAt, prCreatedAt } of cases) {
      expect(evaluatePriorityEligibilityWindow({ windowMinutes: 30, labeledAt, prCreatedAt }).eligible, JSON.stringify({ labeledAt, prCreatedAt })).toBe(true);
    }
  });

  it("ignores a non-finite window rather than treating it as infinite", () => {
    for (const windowMinutes of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluatePriorityEligibilityWindow({ windowMinutes, labeledAt: LABELED_AT, prCreatedAt: LABELED_AT }).eligible).toBe(true);
    }
  });

  it("truncates a fractional window rather than rounding it up", () => {
    // 30.9 minutes is a 30-minute window; a contributor must never wait longer than the number they were told.
    const result = evaluatePriorityEligibilityWindow({ windowMinutes: 30.9, labeledAt: LABELED_AT, prCreatedAt: ELIGIBLE_AT });
    expect(result.eligible).toBe(true);
  });

  describe("priorityEligibleAt", () => {
    it("states the moment work opens", () => {
      expect(priorityEligibleAt(LABELED_AT, 30)).toBe(ELIGIBLE_AT);
    });

    it("is null when the window is off or the label time is unknown", () => {
      expect(priorityEligibleAt(LABELED_AT, 0)).toBeNull();
      expect(priorityEligibleAt(LABELED_AT, Number.NaN)).toBeNull();
      expect(priorityEligibleAt(null, 30)).toBeNull();
      expect(priorityEligibleAt("not-a-date", 30)).toBeNull();
    });
  });

  it("exposes a stable rule id and sane bounds", () => {
    // The id is written to the ledger with every enforcement decision, so it is part of the contract.
    expect(PRIORITY_ELIGIBILITY_RULE_ID).toBe("priority-eligibility-window");
    expect(MIN_PRIORITY_ELIGIBILITY_WINDOW_MINUTES).toBe(0);
    expect(MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES).toBe(1440);
    expect(DEFAULT_PRIORITY_ELIGIBILITY_WINDOW_MINUTES).toBeGreaterThan(MIN_PRIORITY_ELIGIBILITY_WINDOW_MINUTES);
    expect(DEFAULT_PRIORITY_ELIGIBILITY_WINDOW_MINUTES).toBeLessThan(MAX_PRIORITY_ELIGIBILITY_WINDOW_MINUTES);
  });
});

// The impure half: which linked issue is consulted, and every way the resolution declines to hold.
describe("resolvePriorityEligibilityHold (#9738)", () => {
  const base = {
    env: {},
    repoFullName: "owner/repo",
    prCreatedAt: "2026-07-29T12:00:30.000Z",
    windowMinutes: 30,
    priorityLabel: "gittensor:priority",
    token: "t",
  };

  it("holds on a linked priority issue still inside its window", async () => {
    const hold = await resolvePriorityEligibilityHold({ ...base, linkedIssues: [7], fetchLabeledAt: async () => LABELED_AT });
    expect(hold?.reason).toContain(PRIORITY_ELIGIBILITY_RULE_ID);
    expect(hold?.reason).toContain("#7");
    expect(hold?.reason).toContain(ELIGIBLE_AT);
    expect(hold?.comment).toContain(ELIGIBLE_AT);
  });

  it("waits for the LATER of two priority issues, so linking a second never skips the first's window", async () => {
    const labels = new Map([
      [1, "2026-07-29T10:00:00.000Z"], // long elapsed
      [2, LABELED_AT], // still inside
    ]);
    const hold = await resolvePriorityEligibilityHold({
      ...base,
      linkedIssues: [1, 2],
      fetchLabeledAt: async (_repo, issueNumber) => labels.get(issueNumber) ?? null,
    });
    expect(hold?.reason).toContain("#2");
  });

  it("does not hold once every linked issue's window has elapsed", async () => {
    const hold = await resolvePriorityEligibilityHold({ ...base, linkedIssues: [1], fetchLabeledAt: async () => "2026-07-29T10:00:00.000Z" });
    expect(hold).toBeUndefined();
  });

  it("skips the read entirely when the caller says the issue has no priority label", async () => {
    let reads = 0;
    const hold = await resolvePriorityEligibilityHold({
      ...base,
      linkedIssues: [5],
      issueLabels: new Map([[5, ["gittensor:bug"]]]),
      fetchLabeledAt: async () => {
        reads += 1;
        return LABELED_AT;
      },
    });
    expect(hold).toBeUndefined();
    expect(reads, "a non-priority issue must cost no GitHub read").toBe(0);
  });

  it("still reads when the caller's labels DO include priority", async () => {
    const hold = await resolvePriorityEligibilityHold({
      ...base,
      linkedIssues: [5],
      issueLabels: new Map([[5, ["Gittensor:Priority"]]]),
      fetchLabeledAt: async () => LABELED_AT,
    });
    expect(hold, "label matching is case-insensitive").toBeDefined();
  });

  it("FAILS OPEN on everything it cannot establish", async () => {
    const never = async () => LABELED_AT;
    const cases: Array<[string, Parameters<typeof resolvePriorityEligibilityHold>[0]]> = [
      ["window off", { ...base, windowMinutes: 0, linkedIssues: [1], fetchLabeledAt: never }],
      ["no linked issues", { ...base, linkedIssues: [], fetchLabeledAt: never }],
      ["null linked issues", { ...base, linkedIssues: null, fetchLabeledAt: never }],
      ["no PR timestamp", { ...base, prCreatedAt: null, linkedIssues: [1], fetchLabeledAt: never }],
      ["no token", { ...base, token: undefined, linkedIssues: [1], fetchLabeledAt: never }],
      ["no label configured", { ...base, priorityLabel: undefined, linkedIssues: [1], fetchLabeledAt: never }],
      ["no fetcher", { ...base, linkedIssues: [1] }],
      ["label never applied", { ...base, linkedIssues: [1], fetchLabeledAt: async () => null }],
      ["fetch throws", { ...base, linkedIssues: [1], fetchLabeledAt: async () => { throw new Error("GitHub 502"); } }],
    ];
    for (const [name, input] of cases) {
      expect(await resolvePriorityEligibilityHold(input), name).toBeUndefined();
    }
  });
});
