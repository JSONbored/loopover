import { describe, expect, it, vi } from "vitest";
import * as duplicateWinner from "../../packages/gittensory-engine/src/duplicate-winner";
import {
  buildSelfPlagiarismGovernorLedgerEvent,
  DEFAULT_SELF_PLAGIARISM_CONFIG,
  DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
  fingerprintSimilarity,
  resolveSelfPlagiarismConfig,
  selfPlagiarismCheck,
  type OwnSubmissionRecord,
} from "../../packages/gittensory-engine/src/governor/self-plagiarism";

const CANDIDATE_AT = "2026-07-10T12:00:00.000Z";

function candidate(overrides: Partial<OwnSubmissionRecord> = {}): OwnSubmissionRecord {
  return {
    repoFullName: "acme/widgets",
    fingerprint: "alpha beta gamma",
    submittedAt: CANDIDATE_AT,
    pullRequestNumber: 200,
    ...overrides,
  };
}

function prior(overrides: Partial<OwnSubmissionRecord> = {}): OwnSubmissionRecord {
  return {
    repoFullName: "acme/other",
    fingerprint: "totally different tokens",
    submittedAt: "2026-07-09T12:00:00.000Z",
    pullRequestNumber: 100,
    ...overrides,
  };
}

describe("fingerprintSimilarity", () => {
  it("returns 1 for identical normalized fingerprints", () => {
    expect(fingerprintSimilarity("abc def", "ABC DEF")).toBe(1);
  });

  it("returns 0 when either fingerprint token set is empty", () => {
    expect(fingerprintSimilarity("", "abc")).toBe(0);
    expect(fingerprintSimilarity("abc", "   ")).toBe(0);
  });

  it("returns 1 when both normalized token sets are empty", () => {
    expect(fingerprintSimilarity("   ", "  ")).toBe(1);
  });

  it("returns partial Jaccard overlap for overlapping token sets", () => {
    expect(fingerprintSimilarity("aa bb", "bb cc")).toBeCloseTo(1 / 3);
  });
});

describe("resolveSelfPlagiarismConfig", () => {
  it("returns defaults for nullish and invalid top-level shapes", () => {
    expect(resolveSelfPlagiarismConfig(undefined)).toEqual({ ...DEFAULT_SELF_PLAGIARISM_CONFIG });
    expect(resolveSelfPlagiarismConfig(null)).toEqual({ ...DEFAULT_SELF_PLAGIARISM_CONFIG });
    expect(resolveSelfPlagiarismConfig(["not", "object"])).toEqual({ ...DEFAULT_SELF_PLAGIARISM_CONFIG });
    expect(resolveSelfPlagiarismConfig("0.9")).toEqual({ ...DEFAULT_SELF_PLAGIARISM_CONFIG });
  });

  it("accepts a bare numeric threshold and normalizes it", () => {
    expect(resolveSelfPlagiarismConfig(0.9).similarityThreshold).toBe(0.9);
    expect(resolveSelfPlagiarismConfig(Number.NaN).similarityThreshold).toBe(0.85);
    expect(resolveSelfPlagiarismConfig(2).similarityThreshold).toBe(1);
    expect(resolveSelfPlagiarismConfig(-1).similarityThreshold).toBe(0);
  });

  it("reads similarityThreshold from an object or falls back to default when absent", () => {
    expect(resolveSelfPlagiarismConfig({ similarityThreshold: 0.7 }).similarityThreshold).toBe(0.7);
    expect(resolveSelfPlagiarismConfig({}).similarityThreshold).toBe(0.85);
  });
});

describe("selfPlagiarismCheck (#2345)", () => {
  it("allows a genuinely distinct PR against recent own submissions", () => {
    const verdict = selfPlagiarismCheck(candidate(), [prior()]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.eventType).toBe("allowed");
    expect(verdict.reason).toBe("distinct_from_recent_own_submissions");
  });

  it("throttles a near-duplicate diff across two different target repos when the prior claimed first", () => {
    const shared = "fix null pointer in handler cleanup path shared";
    const verdict = selfPlagiarismCheck(
      candidate({ repoFullName: "acme/repo-b", fingerprint: shared, pullRequestNumber: 201 }),
      [
        prior({
          repoFullName: "acme/repo-a",
          fingerprint: `${shared} extra`,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: 55,
        }),
      ],
      { similarityThreshold: 0.85 },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.eventType).toBe("throttled");
    expect(verdict.reason).toBe("near_duplicate_self_plagiarism");
    expect(verdict.matchedSubmission?.repoFullName).toBe("acme/repo-a");
    expect(verdict.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("denies when the candidate fingerprint is missing (fail closed — does not assume uniqueness)", () => {
    const verdict = selfPlagiarismCheck(candidate({ fingerprint: "  " }), [prior()]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_fingerprint" });
  });

  it("denies when the candidate submittedAt is missing even if fingerprints differ", () => {
    const verdict = selfPlagiarismCheck(candidate({ submittedAt: null }), [prior()]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_submitted_at" });
  });

  it("denies when a near-duplicate prior lacks submittedAt (ambiguous election timing)", () => {
    const shared = "shared diff fingerprint tokens";
    const verdict = selfPlagiarismCheck(candidate({ fingerprint: shared }), [
      prior({ fingerprint: shared, submittedAt: null }),
    ]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_prior_submitted_at" });
  });

  it("allows the earliest claimant when it precedes near-duplicate priors in claim-time order", () => {
    const shared = "shared implementation patch body";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: shared, submittedAt: "2026-07-10T10:00:00.000Z", pullRequestNumber: 10 }),
      [
        prior({
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: 20,
        }),
      ],
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("earliest_near_duplicate_claimant");
  });

  it("uses the conservative built-in default threshold when config is omitted", () => {
    expect(DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD).toBe(0.85);
    const almost = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: almost }),
      [prior({ fingerprint: `${almost} zz` })],
    );
    expect(verdict.eventType).toBe("throttled");
  });

  it("denies when the candidate fingerprint is non-string", () => {
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: null as unknown as string }),
      [prior()],
    );
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_fingerprint" });
  });

  it("denies when the candidate submittedAt is unparsable", () => {
    const verdict = selfPlagiarismCheck(candidate({ submittedAt: "not-a-date" }), [prior()]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_submitted_at" });
  });

  it("skips priors with missing fingerprints when comparing", () => {
    const verdict = selfPlagiarismCheck(candidate(), [prior({ fingerprint: "   " }), prior()]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("distinct_from_recent_own_submissions");
  });

  it("throttles using issueNumber when pullRequestNumber is absent on the matched prior", () => {
    const shared = "shared patch content across repos";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: shared, submittedAt: "2026-07-10T12:00:00.000Z", pullRequestNumber: 50 }),
      [
        prior({
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: undefined,
          issueNumber: 99,
        }),
      ],
    );
    expect(verdict.eventType).toBe("throttled");
    expect(verdict.matchedSubmission?.issueNumber).toBe(99);
  });

  it("throttles at similarity threshold 0 and reports zero similarity for disjoint fingerprints", () => {
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: "aaa", submittedAt: CANDIDATE_AT }),
      [prior({ fingerprint: "bbb", submittedAt: "2026-07-10T11:00:00.000Z" })],
      { similarityThreshold: 0 },
    );
    expect(verdict.eventType).toBe("throttled");
    expect(verdict.similarity).toBe(0);
  });

  it("keeps the first highest-similarity prior when scores tie", () => {
    const shared = "identical shared tokens";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: shared, submittedAt: "2026-07-10T12:00:00.000Z" }),
      [
        prior({
          repoFullName: "acme/first",
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: 1,
        }),
        prior({
          repoFullName: "acme/second",
          fingerprint: shared,
          submittedAt: "2026-07-10T10:00:00.000Z",
          pullRequestNumber: 2,
        }),
      ],
    );
    expect(verdict.eventType).toBe("throttled");
    expect(verdict.matchedSubmission?.repoFullName).toBe("acme/first");
  });

  it("uses issueNumber on the candidate when pullRequestNumber is absent", () => {
    const shared = "shared claim election tokens";
    const verdict = selfPlagiarismCheck(
      candidate({
        fingerprint: shared,
        submittedAt: "2026-07-10T12:00:00.000Z",
        pullRequestNumber: undefined,
        issueNumber: 88,
      }),
      [prior({ fingerprint: shared, submittedAt: "2026-07-10T11:00:00.000Z", issueNumber: 77 })],
    );
    expect(verdict.eventType).toBe("throttled");
  });

  it("falls back to bestMatch pullRequestNumber when winner resolution is ambiguous", () => {
    const resolveSpy = vi.spyOn(duplicateWinner, "resolveDuplicateClusterWinnerNumber").mockReturnValue(null);
    try {
      const shared = "shared fallback winner tokens";
      const verdict = selfPlagiarismCheck(
        candidate({ fingerprint: shared, submittedAt: "2026-07-10T12:00:00.000Z", pullRequestNumber: 20 }),
        [prior({ fingerprint: shared, submittedAt: "2026-07-10T11:00:00.000Z", pullRequestNumber: 10 })],
      );
      expect(verdict.eventType).toBe("throttled");
      expect(verdict.matchedSubmission?.pullRequestNumber).toBe(10);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("falls back to bestMatch issueNumber when pullRequestNumber is absent and winner resolution is ambiguous", () => {
    const resolveSpy = vi.spyOn(duplicateWinner, "resolveDuplicateClusterWinnerNumber").mockReturnValue(null);
    try {
      const shared = "shared issue fallback tokens";
      const verdict = selfPlagiarismCheck(
        candidate({ fingerprint: shared, submittedAt: "2026-07-10T12:00:00.000Z", pullRequestNumber: 20 }),
        [
          prior({
            fingerprint: shared,
            submittedAt: "2026-07-10T11:00:00.000Z",
            pullRequestNumber: undefined,
            issueNumber: 33,
          }),
        ],
      );
      expect(verdict.matchedSubmission?.issueNumber).toBe(33);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("falls back to the first near-duplicate when winner resolution and bestMatch are absent", () => {
    const resolveSpy = vi.spyOn(duplicateWinner, "resolveDuplicateClusterWinnerNumber").mockReturnValue(null);
    try {
      const verdict = selfPlagiarismCheck(
        candidate({ fingerprint: "aaa", submittedAt: "2026-07-10T12:00:00.000Z", pullRequestNumber: 2 }),
        [
          prior({
            fingerprint: "bbb",
            submittedAt: "2026-07-10T11:00:00.000Z",
            pullRequestNumber: undefined,
            issueNumber: undefined,
          }),
        ],
        { similarityThreshold: 0 },
      );
      expect(verdict.eventType).toBe("throttled");
      expect(verdict.matchedSubmission?.repoFullName).toBe("acme/other");
      expect(verdict.similarity).toBe(0);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("defaults claim member number to zero when neither pull nor issue number is present", () => {
    const shared = "claim member zero fallback";
    const verdict = selfPlagiarismCheck(
      candidate({
        fingerprint: shared,
        submittedAt: "2026-07-10T12:00:00.000Z",
        pullRequestNumber: undefined,
        issueNumber: undefined,
      }),
      [prior({ fingerprint: shared, submittedAt: "2026-07-10T11:00:00.000Z", pullRequestNumber: undefined, issueNumber: undefined })],
    );
    expect(verdict.eventType).toBe("throttled");
  });

  it("uses issueNumber when pullRequestNumber is non-finite", () => {
    const shared = "non-finite pull number election";
    const verdict = selfPlagiarismCheck(
      candidate({
        fingerprint: shared,
        submittedAt: CANDIDATE_AT,
        pullRequestNumber: Number.NaN,
        issueNumber: 44,
      }),
      [
        prior({
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: Number.NaN,
          issueNumber: 33,
        }),
      ],
    );
    expect(verdict.eventType).toBe("throttled");
  });

  it("defaults claim member number to zero when pull and issue numbers are non-finite", () => {
    const shared = "both non-finite numbers";
    const verdict = selfPlagiarismCheck(
      candidate({
        fingerprint: shared,
        submittedAt: CANDIDATE_AT,
        pullRequestNumber: Number.NaN,
        issueNumber: Number.NaN,
      }),
      [
        prior({
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: Number.NaN,
          issueNumber: Number.NaN,
        }),
      ],
    );
    expect(verdict.eventType).toBe("throttled");
  });
});

describe("buildSelfPlagiarismGovernorLedgerEvent", () => {
  it("records a throttled open_pr denial with the flagged prior submission referenced", () => {
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: "same patch tokens" }),
      [prior({ fingerprint: "same patch tokens", pullRequestNumber: 42, repoFullName: "acme/first" })],
    );
    const event = buildSelfPlagiarismGovernorLedgerEvent("acme/second", verdict);
    expect(event).toMatchObject({
      eventType: "throttled",
      repoFullName: "acme/second",
      actionClass: "open_pr",
      decision: "throttle",
      reason: "near_duplicate_self_plagiarism",
      payload: {
        matchedRepoFullName: "acme/first",
        matchedPullRequestNumber: 42,
      },
    });
  });

  it("maps allowed and denied verdicts without matched payload fields", () => {
    expect(
      buildSelfPlagiarismGovernorLedgerEvent("acme/repo", {
        allowed: true,
        eventType: "allowed",
        reason: "distinct_from_recent_own_submissions",
      }),
    ).toMatchObject({ decision: "allow", payload: {} });

    expect(
      buildSelfPlagiarismGovernorLedgerEvent("acme/repo", {
        allowed: false,
        eventType: "denied",
        reason: "missing_candidate_fingerprint",
      }),
    ).toMatchObject({ decision: "deny", payload: {} });
  });

  it("nulls optional matched fields in the throttled payload", () => {
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: "same tokens", submittedAt: CANDIDATE_AT }),
      [
        prior({
          fingerprint: "same tokens",
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: undefined,
          issueNumber: 7,
        }),
      ],
      { similarityThreshold: 0 },
    );
    const event = buildSelfPlagiarismGovernorLedgerEvent("acme/target", verdict);
    expect(event.payload).toMatchObject({
      matchedPullRequestNumber: null,
      matchedIssueNumber: 7,
      matchedSubmittedAt: "2026-07-10T11:00:00.000Z",
    });
  });

  it("nulls matchedSubmittedAt and similarity when the verdict omits them", () => {
    const event = buildSelfPlagiarismGovernorLedgerEvent("acme/target", {
      allowed: false,
      eventType: "throttled",
      reason: "near_duplicate_self_plagiarism",
      matchedSubmission: {
        repoFullName: "acme/prior",
        fingerprint: "fp",
        submittedAt: undefined,
        pullRequestNumber: 1,
      },
    });
    expect(event.payload).toEqual({
      matchedRepoFullName: "acme/prior",
      matchedPullRequestNumber: 1,
      matchedIssueNumber: null,
      matchedSubmittedAt: null,
      similarity: null,
    });
  });
});
