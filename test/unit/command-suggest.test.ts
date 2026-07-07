import { describe, expect, it } from "vitest";
import {
  COMMAND_SUGGEST_MAX_DISTANCE,
  COMMAND_SUGGEST_MAX_VERB_LENGTH,
  buildDidYouMeanSections,
  formatDidYouMeanLine,
  isKnownGittensoryCommandVerb,
  levenshteinDistance,
  suggestCommand,
  type CommandSuggestCatalog,
} from "../../src/github/command-suggest";
import { suggestCommand as liveSuggestCommand } from "../../src/github/commands";

const catalog: CommandSuggestCatalog = {
  mentionCommands: ["help", "ask", "preflight", "blockers"],
  actionCommands: ["gate-override", "review", "pause"],
  actionAliases: { "re-review": "review" },
};

describe("levenshteinDistance", () => {
  it("covers equal, empty, insert, delete, and substitute paths", () => {
    expect(levenshteinDistance("help", "help")).toBe(0);
    expect(levenshteinDistance("", "")).toBe(0);
    expect(levenshteinDistance("", "help")).toBe(4);
    expect(levenshteinDistance("help", "")).toBe(4);
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("ab", "a")).toBe(1);
    expect(levenshteinDistance("a", "ab")).toBe(1);
    expect(levenshteinDistance("abc", "axc")).toBe(1);
  });
});

describe("isKnownGittensoryCommandVerb", () => {
  it("recognizes mention commands, action commands, and aliases", () => {
    expect(isKnownGittensoryCommandVerb("preflight", catalog)).toBe(true);
    expect(isKnownGittensoryCommandVerb("review", catalog)).toBe(true);
    expect(isKnownGittensoryCommandVerb("re-review", catalog)).toBe(true);
    expect(isKnownGittensoryCommandVerb("reveiw", catalog)).toBe(false);
    expect(isKnownGittensoryCommandVerb("", catalog)).toBe(false);
    expect(isKnownGittensoryCommandVerb("   ", catalog)).toBe(false);
  });
});

describe("suggestCommand", () => {
  it("suggests the nearest command within the distance threshold", () => {
    expect(suggestCommand("prefliht", catalog)).toBe("preflight");
    expect(suggestCommand("reveiw", catalog)).toBe("review");
    expect(suggestCommand("gate-overrid", catalog)).toBe("gate-override");
    expect(COMMAND_SUGGEST_MAX_DISTANCE).toBe(2);
  });

  it("returns null for empty, known, and far-off verbs", () => {
    expect(suggestCommand("", catalog)).toBeNull();
    expect(suggestCommand("   ", catalog)).toBeNull();
    expect(suggestCommand("help", catalog)).toBeNull();
    expect(suggestCommand("review", catalog)).toBeNull();
    expect(suggestCommand("re-review", catalog)).toBeNull();
    expect(suggestCommand("zzzz", catalog)).toBeNull();
    expect(suggestCommand("xyzzyqwerty", catalog)).toBeNull();
  });

  it("skips suggestions for oversized unknown verbs", () => {
    const oversizedVerb = "a".repeat(COMMAND_SUGGEST_MAX_VERB_LENGTH + 1);

    expect(suggestCommand(oversizedVerb, catalog)).toBeNull();
  });

  it("keeps the closest catalog entry when multiple targets are within range", () => {
    expect(suggestCommand("hel", catalog)).toBe("help");
  });

  it("suggests against the live production command catalog", () => {
    expect(liveSuggestCommand("reveiw")).toBe("review");
    expect(liveSuggestCommand("prefliht")).toBe("preflight");
    expect(liveSuggestCommand("queue-summry")).toBe("queue-summary");
  });
});

describe("formatDidYouMeanLine", () => {
  it("renders a public-safe markdown hint", () => {
    expect(formatDidYouMeanLine("preflight")).toBe(
      "- Did you mean `@gittensory preflight`?",
    );
  });
});

describe("buildDidYouMeanSections", () => {
  const suggest = (verb: string) => suggestCommand(verb, catalog);

  it("renders a hint for close typos and empty arrays otherwise", () => {
    expect(buildDidYouMeanSections("reveiw", suggest)).toEqual([
      "- Did you mean `@gittensory review`?",
      "",
    ]);
    expect(buildDidYouMeanSections(undefined, suggest)).toEqual([]);
    expect(buildDidYouMeanSections("zzzz", suggest)).toEqual([]);
  });
});
