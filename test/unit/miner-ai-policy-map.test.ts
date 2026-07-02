import { describe, expect, it } from "vitest";
import { resolveAiPolicyVerdict, scanAiPolicyText } from "../../packages/gittensory-engine/src/ai-policy-map";

describe("miner AI policy map (#2305)", () => {
  it.each([
    ["We allow bug fixes, but no AI-generated pull requests.", "no ai-generated pull requests"],
    ["AI-generated PRs are rejected by maintainers.", "ai-generated prs are rejected"],
    ["Do not submit AI-written code in this repository.", "do not submit ai-generated code"],
    ["LLM-generated code is not accepted here.", "llm-generated code is not accepted"],
  ])("denies explicit ban phrase: %s", (content, phrase) => {
    expect(scanAiPolicyText(content, "CONTRIBUTING.md")).toEqual({
      allowed: false,
      matchedPhrase: phrase,
      source: "CONTRIBUTING.md",
    });
  });

  it("allows safe or empty policy text without inventing a ban", () => {
    expect(scanAiPolicyText("Please include tests and a clear description.", "CONTRIBUTING.md")).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "CONTRIBUTING.md",
    });
    expect(scanAiPolicyText("", "AI-USAGE.md")).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "AI-USAGE.md",
    });
    expect(scanAiPolicyText(null, "CONTRIBUTING.md")).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "CONTRIBUTING.md",
    });
    expect(scanAiPolicyText(undefined, "none")).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "none",
    });
  });

  it("lets AI-USAGE.md take precedence over CONTRIBUTING.md", () => {
    expect(
      resolveAiPolicyVerdict({
        aiUsage: "AI-assisted contributions are allowed when reviewed.",
        contributing: "No AI-generated pull requests.",
      }),
    ).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "AI-USAGE.md",
    });
  });

  it("falls back to CONTRIBUTING.md and then to the absent-doc default", () => {
    expect(resolveAiPolicyVerdict({ aiUsage: null, contributing: "AI-generated PRs are not accepted." })).toEqual({
      allowed: false,
      matchedPhrase: "ai-generated prs are rejected",
      source: "CONTRIBUTING.md",
    });
    expect(resolveAiPolicyVerdict({ aiUsage: null, contributing: null })).toEqual({
      allowed: true,
      matchedPhrase: null,
      source: "none",
    });
  });
});
