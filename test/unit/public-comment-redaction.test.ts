import { describe, expect, it } from "vitest";
// #4882: the public-comment redactor was extracted out of src/github/commands.ts into gittensory-engine. This
// suite drives it through the ENGINE barrel (proving portability + covering the moved src) and asserts the
// redaction behavior is byte-for-byte what the command layer relied on.
import { sanitizePublicComment } from "../../packages/gittensory-engine/src/index";

describe("sanitizePublicComment (extracted to @loopover/engine, #4882)", () => {
  it("redacts private scoring / credibility / threshold phrases to 'private context'", () => {
    expect(sanitizePublicComment("open pr count 12 exceeds threshold 10.")).toBe("private context");
    expect(sanitizePublicComment("open pr count is at or below 5")).toBe("private context");
    expect(sanitizePublicComment("merged pr count 3 is below upstream floor 8.")).toBe("private context");
    expect(sanitizePublicComment("credibility -2.5 is below floor -1.0.")).toBe("private context");
    expect(
      sanitizePublicComment(
        "issue-discovery history (2 valid solved, credibility -3) is below upstream floors (5 valid solved, -1 credibility).",
      ),
    ).toBe("private context");
  });

  it("redacts reward/wallet/ranking/internal-key terminology (surrounding text preserved)", () => {
    expect(sanitizePublicComment("your estimated rewards and payouts")).toBe("your private context and private context");
    // Comma-separated markers collapse to a single 'private context' via the dedup pass.
    expect(sanitizePublicComment("raw trust scores, wallets, hotkeys, coldkeys")).toBe("private context");
    expect(sanitizePublicComment("private rankings")).toBe("private context");
    expect(sanitizePublicComment("open_pr_pressure and low_credibility")).toBe("private context and private context");
    expect(sanitizePublicComment("likely_duplicate")).toBe("possible overlap with existing work");
  });

  it("redacts a score transition and collapses a residual bare numeric transition + repeated markers", () => {
    // "estimated score from 32.5 -> 41.2" → phrase redaction, then the catch-all eats the residual numbers.
    expect(sanitizePublicComment("estimated score from 32.5 -> 41.2")).toBe("private context");
    expect(sanitizePublicComment("score preview 10 to 20")).toBe("private context");
    // Repeated adjacent markers collapse to a single one.
    expect(sanitizePublicComment("rewards, payouts")).toBe("private context");
  });

  it("redacts a bare 'reviewability' but keeps the literal @loopover reviewability command name", () => {
    expect(sanitizePublicComment("check the reviewability internals")).toBe("check the private context");
    // A bare 'reviewability' NOT preceded by '@loopover ' (and not caught by an earlier phrase) is redacted.
    expect(sanitizePublicComment("the reviewability of this PR")).toBe("the private context of this PR");
    expect(sanitizePublicComment("run @loopover reviewability to see it")).toBe(
      "run @loopover reviewability to see it",
    );
  });

  it("leaves ordinary text untouched (pure, no false positives)", () => {
    expect(sanitizePublicComment("Thanks for the contribution — merged!")).toBe(
      "Thanks for the contribution — merged!",
    );
    expect(sanitizePublicComment("")).toBe("");
  });
});
