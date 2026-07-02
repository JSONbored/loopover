import { describe, expect, it } from "vitest";
import { isAutoCloseExempt, normalizeAutoCloseExemptLogins } from "../../src/settings/auto-close-exempt";

describe("normalizeAutoCloseExemptLogins (#2463)", () => {
  it("returns [] for null/undefined and a non-array (with a warning)", () => {
    expect(normalizeAutoCloseExemptLogins(undefined).logins).toEqual([]);
    expect(normalizeAutoCloseExemptLogins(null).logins).toEqual([]);
    const notArray = normalizeAutoCloseExemptLogins({ login: "x" });
    expect(notArray.logins).toEqual([]);
    expect(notArray.warnings[0]).toMatch(/must be a list/);
  });

  it("accepts valid GitHub logins (alnum, single internal hyphen, ≤39 chars)", () => {
    const { logins } = normalizeAutoCloseExemptLogins(["a-b", "user123", "a".repeat(39)]);
    expect(logins).toEqual(["a-b", "user123", "a".repeat(39)]);
  });

  it("drops non-string and invalid-login entries with a warning", () => {
    const { logins, warnings } = normalizeAutoCloseExemptLogins([42, "-bad", "bad-", "a--b", "has space", "a".repeat(40)]);
    expect(logins).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });

  it("trims whitespace around a login", () => {
    const { logins } = normalizeAutoCloseExemptLogins(["  spaced-login  "]);
    expect(logins).toEqual(["spaced-login"]);
  });

  it("de-duplicates by case-insensitive login, keeping the FIRST occurrence's casing", () => {
    const { logins } = normalizeAutoCloseExemptLogins(["Mona", "mona"]);
    expect(logins).toEqual(["Mona"]);
  });

  it("caps the list and warns when over the limit", () => {
    const many = Array.from({ length: 505 }, (_, i) => `user${i}`);
    const { logins, warnings } = normalizeAutoCloseExemptLogins(many);
    expect(logins).toHaveLength(500);
    expect(warnings.some((w) => w.includes("capped"))).toBe(true);
  });
});

describe("isAutoCloseExempt (#2463)", () => {
  it("matches case-insensitively", () => {
    expect(isAutoCloseExempt("mona", ["Mona", "octocat"])).toBe(true);
    expect(isAutoCloseExempt("OCTOCAT", ["Mona", "octocat"])).toBe(true);
  });

  it("returns false for a non-match, a missing login, or an absent/empty list", () => {
    expect(isAutoCloseExempt("stranger", ["Mona"])).toBe(false);
    expect(isAutoCloseExempt(null, ["Mona"])).toBe(false);
    expect(isAutoCloseExempt(undefined, ["Mona"])).toBe(false);
    expect(isAutoCloseExempt("anyone", undefined)).toBe(false);
    expect(isAutoCloseExempt("anyone", [])).toBe(false);
  });
});
