import { describe, expect, it } from "vitest";
import {
  LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
  __linkedIssueSatisfactionInternals,
  buildLinkedIssueSatisfactionResult,
  parseLinkedIssueSatisfactionOpinion,
  type LinkedIssueSatisfactionInput,
} from "../../src/services/linked-issue-satisfaction";

const { buildLinkedIssueSatisfactionPrompt } = __linkedIssueSatisfactionInternals;

function opinionJson(over: Partial<{ status: string; rationale: string; confidence: number }> = {}): string {
  return JSON.stringify({
    status: over.status ?? "addressed",
    rationale: over.rationale ?? "The diff renames the field exactly as the issue asked.",
    confidence: over.confidence ?? 0.9,
  });
}

describe("parseLinkedIssueSatisfactionOpinion", () => {
  it("parses a well-formed addressed opinion", () => {
    const parsed = parseLinkedIssueSatisfactionOpinion(opinionJson({ status: "addressed" }));
    expect(parsed).toMatchObject({ status: "addressed", confidence: 0.9 });
  });

  it("parses a well-formed partial opinion", () => {
    const parsed = parseLinkedIssueSatisfactionOpinion(opinionJson({ status: "partial", rationale: "Fixes the crash but not the doc update." }));
    expect(parsed?.status).toBe("partial");
  });

  it("parses an unaddressed opinion when confidence clears the floor", () => {
    const parsed = parseLinkedIssueSatisfactionOpinion(opinionJson({ status: "unaddressed", confidence: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR }));
    expect(parsed?.status).toBe("unaddressed");
  });

  it("suppresses an unaddressed verdict below the confidence floor (fail-safe)", () => {
    const parsed = parseLinkedIssueSatisfactionOpinion(
      opinionJson({ status: "unaddressed", confidence: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR - 0.01 }),
    );
    expect(parsed).toBeNull();
  });

  it("never suppresses addressed/partial for a low confidence (only unaddressed is floor-gated)", () => {
    expect(parseLinkedIssueSatisfactionOpinion(opinionJson({ status: "addressed", confidence: 0 }))?.status).toBe("addressed");
    expect(parseLinkedIssueSatisfactionOpinion(opinionJson({ status: "partial", confidence: 0 }))?.status).toBe("partial");
  });

  it("strips a ```json code fence before parsing", () => {
    expect(parseLinkedIssueSatisfactionOpinion("```json\n" + opinionJson({ status: "partial" }) + "\n```")?.status).toBe("partial");
  });

  it("rejects an invalid status", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "resolved", rationale: "x", confidence: 1 }))).toBeNull();
  });

  it("rejects an empty rationale", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "addressed", rationale: "", confidence: 1 }))).toBeNull();
  });

  it("rejects a non-string rationale", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "addressed", rationale: 12345, confidence: 1 }))).toBeNull();
  });

  it("returns null on non-JSON text", () => {
    expect(parseLinkedIssueSatisfactionOpinion("the model refused to answer")).toBeNull();
  });

  it("returns null when a brace-shaped blob is not valid JSON (parse throws)", () => {
    expect(parseLinkedIssueSatisfactionOpinion("{ status: addressed, rationale: nope }")).toBeNull();
  });

  it("caps a long rationale", () => {
    const parsed = parseLinkedIssueSatisfactionOpinion(opinionJson({ rationale: "x".repeat(1000) }));
    expect(parsed?.rationale.length).toBe(400);
  });

  it("defaults confidence to 0 (lowest, not highest) when absent/unparseable", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "partial", rationale: "ok" }))?.confidence).toBe(0);
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "partial", rationale: "ok", confidence: "not-a-number" }))?.confidence).toBe(0);
  });

  it("rejects an out-of-range confidence (negative or > 1) by defaulting to 0", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "partial", rationale: "ok", confidence: -0.5 }))?.confidence).toBe(0);
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "partial", rationale: "ok", confidence: 1.5 }))?.confidence).toBe(0);
  });

  it("accepts a numeric-string confidence", () => {
    expect(parseLinkedIssueSatisfactionOpinion(JSON.stringify({ status: "addressed", rationale: "ok", confidence: "0.75" }))?.confidence).toBe(0.75);
  });
});

describe("buildLinkedIssueSatisfactionPrompt", () => {
  const base: LinkedIssueSatisfactionInput = { issueText: "Fix the crash on empty input", prTitle: "fix: guard empty input", diff: "diff --git a/x" };

  it("omits the description line when the PR body is absent", () => {
    const prompt = buildLinkedIssueSatisfactionPrompt(base);
    expect(prompt).toContain("Description: (none)");
    expect(prompt).toContain("Fix the crash on empty input");
  });

  it("includes the description when the PR body is present", () => {
    const prompt = buildLinkedIssueSatisfactionPrompt({ ...base, prBody: "Adds a guard clause" });
    expect(prompt).toContain("Adds a guard clause");
    expect(prompt).not.toContain("Description: (none)");
  });

  it("treats a whitespace-only PR body the same as absent", () => {
    const prompt = buildLinkedIssueSatisfactionPrompt({ ...base, prBody: "   " });
    expect(prompt).toContain("Description: (none)");
  });

  it("treats absent issue text as empty rather than throwing", () => {
    const prompt = buildLinkedIssueSatisfactionPrompt({ ...base, issueText: null });
    expect(prompt).toContain("Linked issue text:\n");
  });
});

describe("buildLinkedIssueSatisfactionResult", () => {
  it("returns null when the issue text is absent (fail-safe: never assessed without real issue text)", () => {
    expect(buildLinkedIssueSatisfactionResult(null, opinionJson())).toBeNull();
    expect(buildLinkedIssueSatisfactionResult(undefined, opinionJson())).toBeNull();
  });

  it("returns null when the issue text is empty/whitespace-only", () => {
    expect(buildLinkedIssueSatisfactionResult("   ", opinionJson())).toBeNull();
  });

  it("returns a public-safe result for a well-formed model response", () => {
    const result = buildLinkedIssueSatisfactionResult("Fix the crash", opinionJson({ status: "addressed" }));
    expect(result).toMatchObject({ status: "addressed" });
    expect(result?.rationale).toContain("renames the field");
  });

  it("returns null when the model output does not parse (model error path)", () => {
    expect(buildLinkedIssueSatisfactionResult("Fix the crash", "not json at all")).toBeNull();
  });

  it("returns null when a below-floor unaddressed call is attempted", () => {
    const result = buildLinkedIssueSatisfactionResult(
      "Fix the crash",
      opinionJson({ status: "unaddressed", confidence: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR - 0.1 }),
    );
    expect(result).toBeNull();
  });

  it("returns a result for an unaddressed call that clears the floor", () => {
    const result = buildLinkedIssueSatisfactionResult(
      "Fix the crash",
      opinionJson({ status: "unaddressed", confidence: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR }),
    );
    expect(result?.status).toBe("unaddressed");
  });

  it("drops the finding when nothing survives public-safe sanitization", () => {
    const result = buildLinkedIssueSatisfactionResult("Fix the crash", opinionJson({ rationale: "reward farming payout" }));
    if (result) expect(result.rationale).not.toMatch(/reward|farming|payout/i);
  });

  it("is fail-safe against a thrown parse error (never throws)", () => {
    // A non-string is not realistic from a caller, but guards the try/catch path defensively.
    expect(() => buildLinkedIssueSatisfactionResult("Fix the crash", null as unknown as string)).not.toThrow();
    expect(buildLinkedIssueSatisfactionResult("Fix the crash", null as unknown as string)).toBeNull();
  });
});
