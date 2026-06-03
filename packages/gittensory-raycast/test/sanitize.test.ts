import { describe, expect, it } from "vitest";
import { assertNoForbiddenPublicText, sanitizePublicText } from "../lib/sanitize";

const forbiddenSamples = [
  "wallet balance",
  "hotkey registration",
  "raw trust score",
  "payout schedule",
  "reward estimate",
  "farming loop",
  "private reviewability",
  "public score estimate",
  "private scoreability",
];

describe("sanitizePublicText", () => {
  it("redacts forbidden public language", () => {
    for (const sample of forbiddenSamples) {
      expect(sanitizePublicText(sample)).toMatch(/private surfaces/i);
    }
    expect(sanitizePublicText("  signed in  ")).toBe("signed in");
    expect(sanitizePublicText("")).toBe("");
  });
});

describe("assertNoForbiddenPublicText", () => {
  it("throws when forbidden language is present", () => {
    expect(() => assertNoForbiddenPublicText("wallet")).toThrow(/wallet|hotkey|trust score/i);
    expect(() => assertNoForbiddenPublicText("ok")).not.toThrow();
  });
});
