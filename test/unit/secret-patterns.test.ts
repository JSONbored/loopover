import { describe, expect, it } from "vitest";
import {
  ADVISORY_ONLY_SECRET_KINDS,
  GENERIC_SECRET_ASSIGNMENT_PATTERN,
  HARD_SECRET_KINDS,
  hasGenericSecretAssignment,
  hasLongSequentialRun,
  isPlaceholderSecretValue,
  looksLikeDescriptivePlaceholderPhrase,
  SECRET_PATTERNS,
} from "../../src/review/secret-patterns";

// Direct unit coverage of the shared module extracted in #4608. secrets-scan.test.ts and
// content-lane-security-scan.test.ts already exercise these primitives exhaustively THROUGH their two
// callers' public scanForSecrets()/scanSubmissionContent() surfaces (kept there, unmodified, as the
// no-behavior-change regression guard for the extraction itself) — this file tests the primitives directly,
// at the layer they now actually live at.

describe("secret-patterns — shared secret-detection primitives (#4608)", () => {
  describe("SECRET_PATTERNS / HARD_SECRET_KINDS", () => {
    it("SECRET_PATTERNS is a non-empty array of uniquely named patterns", () => {
      expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
      const names = SECRET_PATTERNS.map((pattern) => pattern.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("HARD_SECRET_KINDS excludes the weak seed-phrase/bittensor-key heuristics and generic_secret_assignment", () => {
      expect(HARD_SECRET_KINDS.has("seed_or_mnemonic")).toBe(false);
      expect(HARD_SECRET_KINDS.has("bittensor_key")).toBe(false);
      // generic_secret_assignment is a keyword-plus-quoted-value SHAPE heuristic, not a concrete credential
      // format -- gittensory PR #5346 auto-closed a legitimate contributor PR over two inert test-fixture
      // strings that matched this shape but weren't real secrets. Split out into ADVISORY_ONLY_SECRET_KINDS
      // below (regression guard for that incident).
      expect(HARD_SECRET_KINDS.has("generic_secret_assignment")).toBe(false);
    });

    it("every HARD_SECRET_KINDS entry is a real SECRET_PATTERNS name", () => {
      const patternNames = new Set(SECRET_PATTERNS.map((pattern) => pattern.name));
      for (const kind of HARD_SECRET_KINDS) {
        expect(patternNames.has(kind)).toBe(true);
      }
    });
  });

  describe("ADVISORY_ONLY_SECRET_KINDS", () => {
    it("contains exactly generic_secret_assignment, disjoint from HARD_SECRET_KINDS", () => {
      expect([...ADVISORY_ONLY_SECRET_KINDS]).toEqual(["generic_secret_assignment"]);
      for (const kind of ADVISORY_ONLY_SECRET_KINDS) {
        expect(HARD_SECRET_KINDS.has(kind)).toBe(false);
      }
    });
  });

  describe("hasLongSequentialRun", () => {
    it("returns false when the value is too short to reach the threshold", () => {
      expect(hasLongSequentialRun("")).toBe(false);
      expect(hasLongSequentialRun("a")).toBe(false);
      expect(hasLongSequentialRun("ab1")).toBe(false);
    });

    it("detects an ascending monotonic run right at the 6-char threshold, not one short of it", () => {
      expect(hasLongSequentialRun("abcdef")).toBe(true);
      expect(hasLongSequentialRun("abcde")).toBe(false);
    });

    it("detects a descending monotonic run right at the 6-char threshold, not one short of it", () => {
      expect(hasLongSequentialRun("fedcba")).toBe(true);
      expect(hasLongSequentialRun("fedcb")).toBe(false);
    });

    it("resets the run counter when the sequence breaks, but still catches a later run", () => {
      expect(hasLongSequentialRun("abcXdefghi")).toBe(true); // "defghi" tail is a fresh 6-run
      expect(hasLongSequentialRun("acegikmoqs")).toBe(false); // constant +2 stride, never +1/-1
    });

    it("does not mistake a high-entropy, non-monotonic credential-shaped value for a sequential run", () => {
      expect(hasLongSequentialRun("aK9xQ2mZw7Ln4Rv8Pt3Bh6")).toBe(false);
    });
  });

  describe("isPlaceholderSecretValue", () => {
    it("flags a known placeholder phrase", () => {
      expect(isPlaceholderSecretValue("your-api-key-placeholder")).toBe(true);
    });

    it("flags a value built from at most 2 distinct characters", () => {
      expect(isPlaceholderSecretValue("xxxxxxxxxxxxxxxxxxxx")).toBe(true);
      expect(isPlaceholderSecretValue("----------------")).toBe(true);
    });

    it("flags a lowercase-hyphenated mock fixture name", () => {
      expect(isPlaceholderSecretValue("mock-response-value")).toBe(true);
      expect(isPlaceholderSecretValue("some-mock-secret-value")).toBe(true);
    });

    it("does NOT flag a mixed-case/digit-bearing mock-tokenized value (still a plausible credential)", () => {
      expect(isPlaceholderSecretValue("mock-aK9xQ2mZw7Ln4Rv8Pt3Bh6")).toBe(false);
    });

    it("flags every known fixture/enum literal in the closed allowlist", () => {
      expect(isPlaceholderSecretValue("installation-token")).toBe(true);
      expect(isPlaceholderSecretValue("default-session-token")).toBe(true);
      expect(isPlaceholderSecretValue("beta-session-token")).toBe(true);
      expect(isPlaceholderSecretValue("unsafe_install_or_secret")).toBe(true);
    });

    it("does NOT flag a token/secret/key/password-suffixed value that isn't in the closed fixture set (#4579-followup regression)", () => {
      // Same self-naming SHAPE as the known fixtures above (ends in "-token"/"-secret"/"-key"/"-passwd"),
      // but none of these exact literals are in KNOWN_FIXTURE_SECRET_VALUES, so a real human-chosen secret
      // is no longer swept in just because its suffix happens to restate what kind of thing it is.
      expect(isPlaceholderSecretValue("session2024-token")).toBe(false);
      expect(isPlaceholderSecretValue("correct-horse-battery-secret")).toBe(false);
      expect(isPlaceholderSecretValue("legacy-system-passwd")).toBe(false);
      expect(isPlaceholderSecretValue("internal-service-key")).toBe(false);
    });

    it("does NOT flag a multi-segment lowercase passphrase that does not self-name as a secret kind", () => {
      expect(isPlaceholderSecretValue("alpha-bravo-charlie-delta")).toBe(false);
    });

    it("flags a long monotonic character-code run (ascending or descending)", () => {
      expect(isPlaceholderSecretValue("abcdefghijklmnop123")).toBe(true);
      expect(isPlaceholderSecretValue("zyxwvutsrqponmlkj987")).toBe(true);
    });

    it("does NOT flag a genuinely high-entropy credential-shaped value", () => {
      expect(isPlaceholderSecretValue("aK9xQ2mZw7Ln4Rv8Pt3Bh6")).toBe(false);
    });

    it("flags the two real false-positive fixture values from gittensory PR #5346/#5341 (regression)", () => {
      // Neither contains a PLACEHOLDER_VALUE_PATTERN keyword (no "fake"/"dummy"/"sample"/etc.), so before
      // looksLikeDescriptivePlaceholderPhrase these both slipped through as "looks like a secret" and
      // hard-closed a legitimate contributor PR twice in a row.
      expect(isPlaceholderSecretValue("present-value-not-a-real-token")).toBe(true);
      expect(isPlaceholderSecretValue("test-value-should-never-appear-in-doctor-output")).toBe(true);
    });
  });

  describe("looksLikeDescriptivePlaceholderPhrase", () => {
    it("flags the two real false-positive fixture values from gittensory PR #5346/#5341 (regression)", () => {
      expect(looksLikeDescriptivePlaceholderPhrase("present-value-not-a-real-token")).toBe(true);
      expect(looksLikeDescriptivePlaceholderPhrase("test-value-should-never-appear-in-doctor-output")).toBe(true);
    });

    it("does NOT flag a short (<5-segment) phrase even if it contains a function word", () => {
      expect(looksLikeDescriptivePlaceholderPhrase("is-not-real")).toBe(false);
    });

    it("does NOT flag a 5+ segment phrase with a non-lowercase-alpha segment (digits/mixed case)", () => {
      // "abc123" fails the pure-lowercase-letters check even though the rest of the phrase reads as prose --
      // a real high-entropy token embedded in a longer string must stay flagged.
      expect(looksLikeDescriptivePlaceholderPhrase("abc123-is-not-a-real-token")).toBe(false);
    });

    it("does NOT flag a 5+ all-lowercase-word phrase with no function word (a genuine diceware-style passphrase)", () => {
      expect(looksLikeDescriptivePlaceholderPhrase("correct-horse-battery-staple-secret")).toBe(false);
    });

    it("flags a 5+ all-lowercase-word phrase containing a function word, using underscores instead of hyphens", () => {
      expect(looksLikeDescriptivePlaceholderPhrase("this_is_not_a_real_secret")).toBe(true);
    });
  });

  describe("GENERIC_SECRET_ASSIGNMENT_PATTERN", () => {
    it("captures the value directly in group 1 (no wrapping keyword group)", () => {
      GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
      const match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec('token = "aK9xQ2mZw7Ln4Rv8Pt3Bh6"');
      expect(match?.[1]).toBe("aK9xQ2mZw7Ln4Rv8Pt3Bh6");
    });
  });

  describe("hasGenericSecretAssignment", () => {
    it("returns true for a keyword-plus-quoted-value assignment with a high-entropy value", () => {
      expect(hasGenericSecretAssignment('secret = "aK9xQ2mZw7Ln4Rv8Pt3Bh6"')).toBe(true);
    });

    it("returns false for benign text with no assignment shape at all", () => {
      expect(hasGenericSecretAssignment("just a normal sentence")).toBe(false);
    });

    it("returns false when the only candidate value is a placeholder (loop exhausts with no hit)", () => {
      expect(hasGenericSecretAssignment('token = "your-api-key-placeholder"')).toBe(false);
    });

    it("finds a match anywhere in a longer text, not just at the start", () => {
      expect(hasGenericSecretAssignment('benign prose first.\nsecret = "aK9xQ2mZw7Ln4Rv8Pt3Bh6"')).toBe(true);
    });

    it("returns false for the two real false-positive assignments from gittensory PR #5346/#5341 (regression)", () => {
      expect(hasGenericSecretAssignment('GITHUB_TOKEN: "present-value-not-a-real-token"')).toBe(false);
      expect(
        hasGenericSecretAssignment('const secretToken = "test-value-should-never-appear-in-doctor-output";'),
      ).toBe(false);
    });

    it("resets the shared regex's lastIndex on every call, so a prior call cannot corrupt the next scan", () => {
      // GENERIC_SECRET_ASSIGNMENT_PATTERN is a module-level /g regex; a call that returns true early leaves
      // lastIndex at the END of that match. This first call's match runs to the end of a 33-char string.
      const first = 'secret = "aK9xQ2mZw7Ln4Rv8Pt3Bh6"';
      expect(first).toHaveLength(33);
      expect(hasGenericSecretAssignment(first)).toBe(true);
      // Without the explicit `lastIndex = 0` reset at the top of hasGenericSecretAssignment, this second,
      // SHORTER (31-char) string would be scanned starting past its own end and wrongly report no match.
      const second = 'token = "zQ8wN2pL6vX4mK9jH3fR7"';
      expect(second).toHaveLength(31);
      expect(hasGenericSecretAssignment(second)).toBe(true);
    });
  });
});
