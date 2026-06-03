import { describe, expect, it } from "vitest";
import { assertNoForbiddenPublicText, sanitizePublicText } from "../lib/sanitize";

describe("sanitize coverage branches", () => {
  it("covers trust-score and scoreability variants", () => {
    expect(sanitizePublicText("trust-score leak")).toMatch(/private surfaces/i);
    expect(sanitizePublicText("scoreability leak")).toMatch(/private surfaces/i);
    expect(sanitizePublicText("public score prediction")).toMatch(/private surfaces/i);
  });

  it("allows benign status copy", () => {
    assertNoForbiddenPublicText("Signed in as maintainer");
  });
});
