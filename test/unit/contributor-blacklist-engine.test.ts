// AUTO-GENERATED-STYLE mirror of the app suite to cover the gittensory-engine copy (#2280).
// DB round-trip cases stay in the app suite; the engine package only owns the pure normalizers.
import { describe, expect, it } from "vitest";
import { findBlacklistEntry, isAuthorBlacklisted, mergeContributorBlacklists, normalizeContributorBlacklist } from "../../packages/gittensory-engine/src/settings/contributor-blacklist";
import type { ContributorBlacklistEntry } from "../../packages/gittensory-engine/src/types/manifest-deps-types";

describe("normalizeContributorBlacklist (#1425) [engine]", () => {
  it("returns [] for null/undefined and a non-array (with a warning)", () => {
    expect(normalizeContributorBlacklist(undefined).entries).toEqual([]);
    expect(normalizeContributorBlacklist(null).entries).toEqual([]);
    const notArray = normalizeContributorBlacklist({ login: "x" });
    expect(notArray.entries).toEqual([]);
    expect(notArray.warnings[0]).toMatch(/must be a list/);
  });

  it("accepts a bare login string and a full entry object", () => {
    const { entries } = normalizeContributorBlacklist(["octocat", { login: "mona", reason: "farming", evidence: ["https://github.com/o/r/pull/1"], addedAt: "2026-06-26T00:00:00Z" }]);
    expect(entries).toEqual([
      { login: "octocat" },
      { login: "mona", reason: "farming", evidence: ["https://github.com/o/r/pull/1"], addedAt: "2026-06-26T00:00:00Z" },
    ]);
  });

  it("drops entries with no/invalid login", () => {
    const { entries, warnings } = normalizeContributorBlacklist([{ reason: "no login" }, 42, { login: "-bad" }, { login: "bad-" }, { login: "a--b" }, { login: "has space" }, { login: "a".repeat(40) }]);
    expect(entries).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });

  it("accepts valid GitHub logins (alnum, single internal hyphen, ≤39 chars)", () => {
    const { entries } = normalizeContributorBlacklist(["a-b", "user123", "a".repeat(39)]);
    expect(entries.map((e) => e.login)).toEqual(["a-b", "user123", "a".repeat(39)]);
  });

  it("de-duplicates by case-insensitive login, keeping the FIRST (richer) occurrence", () => {
    const { entries } = normalizeContributorBlacklist([{ login: "Mona", reason: "first" }, { login: "mona", reason: "second" }]);
    expect(entries).toEqual([{ login: "Mona", reason: "first" }]);
  });

  it("caps the list and warns when over the limit", () => {
    const many = Array.from({ length: 1005 }, (_, i) => `user${i}`);
    const { entries, warnings } = normalizeContributorBlacklist(many);
    expect(entries).toHaveLength(1000);
    expect(warnings.some((w) => w.includes("capped"))).toBe(true);
  });

  it("normalizes metadata: trims + caps reason, filters/caps evidence, omits empties", () => {
    const { entries } = normalizeContributorBlacklist([
      { login: "a", reason: "  spaced  ", evidence: ["  url  ", "", 5, "u2"], addedAt: "  2026-01-01  " },
      { login: "b", reason: "   ", evidence: [""] },
      { login: "c", reason: "x".repeat(300), evidence: Array.from({ length: 20 }, (_, i) => `e${i}`) },
    ]);
    expect(entries[0]).toEqual({ login: "a", reason: "spaced", evidence: ["url", "u2"], addedAt: "2026-01-01" });
    expect(entries[1]).toEqual({ login: "b" });
    expect(entries[2]?.reason?.length).toBe(200);
    expect(entries[2]?.evidence).toHaveLength(10);
  });
});

describe("findBlacklistEntry / isAuthorBlacklisted [engine]", () => {
  const list: ContributorBlacklistEntry[] = [{ login: "Mona", reason: "farming" }, { login: "octocat" }];

  it("matches case-insensitively and returns the entry", () => {
    expect(findBlacklistEntry("mona", list)?.reason).toBe("farming");
    expect(findBlacklistEntry("OCTOCAT", list)?.login).toBe("octocat");
    expect(isAuthorBlacklisted("Mona", list)).toBe(true);
  });

  it("returns null/false for a non-match or a missing login", () => {
    expect(findBlacklistEntry("stranger", list)).toBeNull();
    expect(findBlacklistEntry(null, list)).toBeNull();
    expect(findBlacklistEntry(undefined, list)).toBeNull();
    expect(isAuthorBlacklisted("stranger", list)).toBe(false);
    expect(isAuthorBlacklisted(null, list)).toBe(false);
  });

  it("tolerates an absent list (treated as empty) so callers can pass the optional setting directly", () => {
    expect(findBlacklistEntry("anyone", undefined)).toBeNull();
    expect(isAuthorBlacklisted("anyone", undefined)).toBe(false);
  });
});

describe("mergeContributorBlacklists (global ∪ per-repo) [engine]", () => {
  it("unions by case-insensitive login, first source's entry wins on a dup", () => {
    const global: ContributorBlacklistEntry[] = [{ login: "Mona", reason: "global" }, { login: "abuser" }];
    const perRepo: ContributorBlacklistEntry[] = [{ login: "mona", reason: "repo" }, { login: "repo-only" }];
    const merged = mergeContributorBlacklists(global, perRepo);
    expect(merged.map((e) => e.login.toLowerCase())).toEqual(["mona", "abuser", "repo-only"]);
    expect(findBlacklistEntry("mona", merged)?.reason).toBe("global");
  });

  it("returns [] for no sources / all-empty sources", () => {
    expect(mergeContributorBlacklists()).toEqual([]);
    expect(mergeContributorBlacklists([], [])).toEqual([]);
  });
});
