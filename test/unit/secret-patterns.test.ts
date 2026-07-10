import { describe, expect, it } from "vitest";
import {
  GENERIC_SECRET_ASSIGNMENT_PATTERN,
  HARD_SECRET_KINDS,
  hasGenericSecretAssignment,
  hasLongSequentialRun,
  isPlaceholderSecretValue,
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

    it("HARD_SECRET_KINDS excludes the weak seed-phrase/bittensor-key heuristics", () => {
      expect(HARD_SECRET_KINDS.has("seed_or_mnemonic")).toBe(false);
      expect(HARD_SECRET_KINDS.has("bittensor_key")).toBe(false);
      expect(HARD_SECRET_KINDS.has("generic_secret_assignment")).toBe(true);
    });

    it("every non-generic HARD_SECRET_KINDS entry is a real SECRET_PATTERNS name", () => {
      const patternNames = new Set(SECRET_PATTERNS.map((pattern) => pattern.name));
      for (const kind of HARD_SECRET_KINDS) {
        if (kind === "generic_secret_assignment") continue;
        expect(patternNames.has(kind)).toBe(true);
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

    it("flags a lowercase identifier whose own last segment self-names as a secret kind", () => {
      expect(isPlaceholderSecretValue("default-session-token")).toBe(true);
      expect(isPlaceholderSecretValue("unsafe_install_or_secret")).toBe(true);
    });

    it("does NOT flag a self-naming-suffix-shaped value once digits/mixed case break the ALL-lowercase check", () => {
      expect(isPlaceholderSecretValue("session2024-token")).toBe(false);
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
