import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { __unlinkedIssueMatchInternals, verifyUnlinkedIssueMatch } from "../../src/review/unlinked-issue-match";

const { buildUserPrompt, parseVerdict } = __unlinkedIssueMatchInternals;

const candidate = { number: 42, title: "webhook retries duplicate", body: "retries are duplicating events under load", labels: [] };

function verdictJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ matched: true, confidence: 0.9, evidence: "diff adds the missing dedup key", ...overrides });
}

describe("verifyUnlinkedIssueMatch", () => {
  it("fails closed (no AI call) when the AI binding is missing", async () => {
    const env = createTestEnv({});
    await expect(verifyUnlinkedIssueMatch(env, { prTitle: "x", prBody: null, diff: "diff", candidate })).resolves.toEqual({
      matched: false,
      confidence: 0,
      evidence: "",
    });
  });

  it("fails closed when the AI binding has no run function", async () => {
    const env = createTestEnv({ AI: {} as unknown as Ai });
    await expect(verifyUnlinkedIssueMatch(env, { prTitle: "x", prBody: null, diff: "diff", candidate })).resolves.toEqual({
      matched: false,
      confidence: 0,
      evidence: "",
    });
  });

  it("returns a matched verdict from the primary model", async () => {
    const run = vi.fn(async () => ({ response: verdictJson() }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const result = await verifyUnlinkedIssueMatch(env, { prTitle: "fix webhook retry dedup", prBody: null, diff: "diff", candidate });
    expect(result).toEqual({ matched: true, confidence: 0.9, evidence: "diff adds the missing dedup key" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a not-matched verdict when the model says so", async () => {
    const run = vi.fn(async () => ({ response: verdictJson({ matched: false, evidence: "unrelated file" }) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const result = await verifyUnlinkedIssueMatch(env, { prTitle: "x", prBody: null, diff: "diff", candidate });
    expect(result).toEqual({ matched: false, confidence: 0.9, evidence: "unrelated file" });
  });

  it("falls back to the second model when the primary throws", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("primary down")).mockResolvedValueOnce({ response: verdictJson() });
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const result = await verifyUnlinkedIssueMatch(env, { prTitle: "x", prBody: null, diff: "diff", candidate });
    expect(result.matched).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when both the primary and fallback throw", async () => {
    const run = vi.fn().mockRejectedValue(new Error("down"));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const result = await verifyUnlinkedIssueMatch(env, { prTitle: "x", prBody: null, diff: "diff", candidate });
    expect(result).toEqual({ matched: false, confidence: 0, evidence: "" });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("parseVerdict", () => {
  it("fails closed when the response has no JSON object at all", () => {
    expect(parseVerdict("I cannot determine this.")).toEqual({ matched: false, confidence: 0, evidence: "" });
  });

  it("fails closed when the extracted braces are not valid JSON", () => {
    expect(parseVerdict("Sure: {matched: true, confidence: 1}")).toEqual({ matched: false, confidence: 0, evidence: "" });
  });

  it("treats matched:true with a missing confidence as NOT matched (fail closed)", () => {
    const result = parseVerdict(JSON.stringify({ matched: true, evidence: "looks related" }));
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("treats matched:true with confidence exactly 0 as NOT matched", () => {
    const result = parseVerdict(JSON.stringify({ matched: true, confidence: 0, evidence: "unsure" }));
    expect(result.matched).toBe(false);
  });

  it("clamps a confidence below 0 up to 0", () => {
    expect(parseVerdict(JSON.stringify({ matched: false, confidence: -0.4 })).confidence).toBe(0);
  });

  it("clamps a confidence above 1 down to 1", () => {
    expect(parseVerdict(JSON.stringify({ matched: true, confidence: 5 })).confidence).toBe(1);
  });

  it("defaults evidence to an empty string when it is not a string", () => {
    expect(parseVerdict(JSON.stringify({ matched: true, confidence: 0.7, evidence: 123 })).evidence).toBe("");
  });

  it("extracts the JSON object even with surrounding prose", () => {
    const result = parseVerdict(`Here is my analysis.\n${verdictJson()}\nThanks.`);
    expect(result.matched).toBe(true);
  });
});

describe("buildUserPrompt", () => {
  it("renders (empty) for a null PR body and a null candidate body", () => {
    const prompt = buildUserPrompt({ prTitle: "t", prBody: null, diff: "d", candidate: { number: 1, title: "i", body: null, labels: [] } });
    expect(prompt).toContain("PULL REQUEST BODY: (empty)");
    expect(prompt).toContain("ISSUE BODY: (empty)");
  });

  it("renders trimmed content for a non-empty PR body and candidate body", () => {
    const prompt = buildUserPrompt({ prTitle: "t", prBody: "  real body  ", diff: "d", candidate: { number: 1, title: "i", body: "  real issue body  ", labels: [] } });
    expect(prompt).toContain("PULL REQUEST BODY: real body");
    expect(prompt).toContain("ISSUE BODY: real issue body");
  });

  it("passes a short diff through unchanged", () => {
    const prompt = buildUserPrompt({ prTitle: "t", prBody: null, diff: "short diff", candidate: { number: 1, title: "i", body: null, labels: [] } });
    expect(prompt).toContain("PULL REQUEST DIFF:\nshort diff");
    expect(prompt).not.toContain("truncated");
  });

  it("truncates a diff over the char budget", () => {
    const bigDiff = "x".repeat(7_000);
    const prompt = buildUserPrompt({ prTitle: "t", prBody: null, diff: bigDiff, candidate: { number: 1, title: "i", body: null, labels: [] } });
    expect(prompt).toContain("… (diff truncated)");
    expect(prompt.length).toBeLessThan(bigDiff.length + 500);
  });
});
