import { describe, expect, it } from "vitest";
import {
  assessCopycat,
  codeShingleList,
  codeShingles,
  containmentScore,
  copycatDirection,
  DEFAULT_COPYCAT_MIN_SCORE,
} from "../../src/signals/copycat";

// Six distinct normalized lines → four 3-line shingles; used as a reusable "prior art" corpus.
const BLOCK = [
  "function add(a, b) {",
  "const total = a + b;",
  "logger.debug(total);",
  "return total;",
  "}",
  "export default add;",
];

// First 4 BLOCK lines (2 contained shingles) + 2 novel lines (2 non-matching shingles) → 50% containment.
const HALF_COPIED = [
  "function add(a, b) {",
  "const total = a + b;",
  "logger.debug(total);",
  "return total;",
  "noveltyOne();",
  "noveltyTwo();",
];

describe("codeShingles", () => {
  it("returns an empty set when every line is blank/whitespace-only", () => {
    expect(codeShingles(["", "   ", "\t"]).size).toBe(0);
  });

  it("collapses a sub-shingle-width snippet into a single whole-block shingle", () => {
    const shingles = codeShingles(["const x = 1;", "const y = 2;"]);
    expect(shingles.size).toBe(1);
    expect([...shingles][0]).toBe("const x = 1;\nconst y = 2;");
  });

  it("produces sliding 3-line shingles for a longer block", () => {
    // 6 non-trivial lines → 6 - 3 + 1 = 4 shingles.
    expect(codeShingles(BLOCK).size).toBe(4);
  });

  it("codeShingleList keeps duplicate shingles that codeShingles (the distinct set) collapses", () => {
    // Two identical 3-line blocks back-to-back → shingles [ABC, BCA, CAB, ABC]: 4 in the list, 3 distinct.
    const repeated = ["alpha();", "beta();", "gamma();", "alpha();", "beta();", "gamma();"];
    expect(codeShingleList(repeated)).toHaveLength(4);
    expect(codeShingles(repeated).size).toBe(3);
  });

  it("ignores blank lines and normalizes whitespace/case before shingling", () => {
    const a = codeShingles(["Const   X = 1;", "", "  const y = 2;  ", "const z = 3;"]);
    const b = codeShingles(["const x = 1;", "const y = 2;", "const z = 3;"]);
    expect([...a]).toEqual([...b]);
  });
});

describe("containmentScore", () => {
  it("is 0 when the candidate has no comparable content", () => {
    expect(containmentScore(["", "  "], BLOCK)).toBe(0);
  });

  it("is 0 when the prior art has no comparable content", () => {
    expect(containmentScore(BLOCK, [])).toBe(0);
  });

  it("is 100 when every candidate shingle appears in the prior art", () => {
    expect(containmentScore(BLOCK, BLOCK)).toBe(100);
  });

  it("is 0 when nothing overlaps", () => {
    expect(containmentScore(["alpha();", "beta();", "gamma();"], BLOCK)).toBe(0);
  });

  it("reports the partial percentage of candidate shingles found in the prior art", () => {
    // Candidate = the first 4 BLOCK lines (2 contained shingles) plus 2 novel lines (2 non-matching shingles)
    // → 4 shingles total, 2 contained → 50%.
    expect(containmentScore(HALF_COPIED, BLOCK)).toBe(50);
  });

  it("counts a repeated copied shingle as a MULTISET, not a distinct set (regression)", () => {
    // Candidate shingles = [ABC, BCA, CAB, ABC]; prior art = {ABC}. Multiset: 2 of 4 contained → 50%.
    // The earlier distinct-Set denominator undercounted this as 1 of 3 → 33%.
    const repeatedCopier = ["alpha();", "beta();", "gamma();", "alpha();", "beta();", "gamma();"];
    const priorArt = ["alpha();", "beta();", "gamma();"];
    expect(containmentScore(repeatedCopier, priorArt)).toBe(50);
  });
});

describe("copycatDirection", () => {
  it("is candidate_copied when the candidate is submitted AFTER the prior art", () => {
    expect(copycatDirection("2026-06-02T00:00:00Z", "2026-06-01T00:00:00Z")).toBe("candidate_copied");
  });

  it("is candidate_is_prior when the candidate is submitted BEFORE the prior art", () => {
    expect(copycatDirection("2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toBe("candidate_is_prior");
  });

  it("is ambiguous on an exact timestamp tie", () => {
    expect(copycatDirection("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")).toBe("ambiguous");
  });

  it("is ambiguous when either timestamp is missing", () => {
    expect(copycatDirection(null, "2026-06-01T00:00:00Z")).toBe("ambiguous");
    expect(copycatDirection("2026-06-01T00:00:00Z", undefined)).toBe("ambiguous");
    expect(copycatDirection("", "2026-06-01T00:00:00Z")).toBe("ambiguous");
  });

  it("is ambiguous when either timestamp is unparseable", () => {
    expect(copycatDirection("not-a-date", "2026-06-01T00:00:00Z")).toBe("ambiguous");
    expect(copycatDirection("2026-06-01T00:00:00Z", "nonsense")).toBe("ambiguous");
  });
});

describe("assessCopycat", () => {
  const laterCopier = {
    candidateLines: BLOCK,
    priorArtLines: BLOCK,
    candidateSubmittedAt: "2026-06-02T00:00:00Z",
    priorSubmittedAt: "2026-06-01T00:00:00Z",
  };

  it("acts (emits a finding) on a high-containment later submission with a non-off mode", () => {
    const result = assessCopycat({ ...laterCopier, mode: "block" });
    expect(result.score).toBe(100);
    expect(result.direction).toBe("candidate_copied");
    expect(result.minScore).toBe(DEFAULT_COPYCAT_MIN_SCORE);
    expect(result.wouldAct).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: "copycat_overlap", severity: "critical" });
    expect(result.findings[0]?.publicText).toContain("100%");
  });

  it("maps each non-off tier to its severity", () => {
    expect(assessCopycat({ ...laterCopier, mode: "warn" }).findings[0]?.severity).toBe("info");
    expect(assessCopycat({ ...laterCopier, mode: "label" }).findings[0]?.severity).toBe("warning");
    expect(assessCopycat({ ...laterCopier, mode: "block" }).findings[0]?.severity).toBe("critical");
  });

  it("never acts when the mode is off (or absent), but still reports the score", () => {
    const off = assessCopycat({ ...laterCopier, mode: "off" });
    expect(off.score).toBe(100);
    expect(off.wouldAct).toBe(false);
    expect(off.findings).toEqual([]);
    const absent = assessCopycat(laterCopier);
    expect(absent.wouldAct).toBe(false);
    expect(absent.findings).toEqual([]);
  });

  it("never acts when the score is below the threshold", () => {
    const result = assessCopycat({
      candidateLines: ["alpha();", "beta();", "gamma();"],
      priorArtLines: BLOCK,
      candidateSubmittedAt: "2026-06-02T00:00:00Z",
      priorSubmittedAt: "2026-06-01T00:00:00Z",
      mode: "block",
    });
    expect(result.score).toBe(0);
    expect(result.wouldAct).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("never acts when the candidate is the EARLIER (victim) submission, even at 100% containment", () => {
    const result = assessCopycat({
      candidateLines: BLOCK,
      priorArtLines: BLOCK,
      candidateSubmittedAt: "2026-06-01T00:00:00Z",
      priorSubmittedAt: "2026-06-02T00:00:00Z",
      mode: "block",
    });
    expect(result.score).toBe(100);
    expect(result.direction).toBe("candidate_is_prior");
    expect(result.wouldAct).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("honors a custom in-range minScore and reports it back", () => {
    // 50% containment with a 40 threshold → acts; the same score with the default 85 would not.
    const acting = assessCopycat({
      candidateLines: HALF_COPIED,
      priorArtLines: BLOCK,
      candidateSubmittedAt: "2026-06-02T00:00:00Z",
      priorSubmittedAt: "2026-06-01T00:00:00Z",
      mode: "label",
      minScore: 40,
    });
    expect(acting.score).toBe(50);
    expect(acting.minScore).toBe(40);
    expect(acting.wouldAct).toBe(true);
  });

  it("clamps and rounds an out-of-range or non-numeric minScore", () => {
    expect(assessCopycat({ ...laterCopier, mode: "off", minScore: -5 }).minScore).toBe(0);
    expect(assessCopycat({ ...laterCopier, mode: "off", minScore: 150 }).minScore).toBe(100);
    expect(assessCopycat({ ...laterCopier, mode: "off", minScore: 82.6 }).minScore).toBe(83);
    expect(assessCopycat({ ...laterCopier, mode: "off", minScore: Number.NaN }).minScore).toBe(DEFAULT_COPYCAT_MIN_SCORE);
    expect(assessCopycat({ ...laterCopier, mode: "off", minScore: null }).minScore).toBe(DEFAULT_COPYCAT_MIN_SCORE);
  });
});
