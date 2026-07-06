import { describe, expect, it } from "vitest";
import { githubCommandsInternals, parseGittensoryMentionCommand, suggestCommand } from "../../src/github/commands";

describe("command suggest coverage (#2170)", () => {
  const { levenshteinDistance } = githubCommandsInternals;

  it("exercises levenshtein insert, delete, and substitute branches", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("ab", "a")).toBe(1);
    expect(levenshteinDistance("a", "ab")).toBe(1);
    expect(levenshteinDistance("abc", "axc")).toBe(1);
  });

  it("keeps the nearest command when later catalog entries are farther away", () => {
    expect(suggestCommand("hel")).toBe("help");
    expect(suggestCommand("gate-overrid")).toBe("gate-override");
  });

  it("returns null for action verbs that are already known", () => {
    expect(suggestCommand("gate-override")).toBeNull();
  });

  it("records unknownVerb only when a non-empty verb fails lookup", () => {
    expect(parseGittensoryMentionCommand(null)).toBeNull();
    expect(parseGittensoryMentionCommand("@gittensory ask what now?")).toMatchObject({
      name: "ask",
      question: "what now?",
      unknownVerb: undefined,
    });
  });
});
