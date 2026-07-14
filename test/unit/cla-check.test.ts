import { describe, expect, it } from "vitest";

import { CLA_CHECK_UNRESOLVED_CODE, CLA_CONSENT_MISSING_CODE, evaluateClaCheck, type ClaCheckConfig } from "../../src/review/cla-check";

const config = (over: Partial<ClaCheckConfig> = {}): ClaCheckConfig => ({
  consentPhrase: null,
  checkRunName: null,
  ...over,
});

describe("evaluateClaCheck (#2564)", () => {
  it("no findings when neither detection method is configured (byte-identical)", () => {
    expect(evaluateClaCheck(config(), { body: "no consent here" })).toEqual([]);
  });

  describe("phrase-match detection", () => {
    it("satisfied (case-insensitive substring) yields no finding", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "I have read and agree to the CLA" }), {
        body: "Some intro.\n\ni HAVE READ AND AGREE TO THE cla\n\nMore text.",
      });
      expect(out).toEqual([]);
    });

    it("missing phrase → cla_consent_missing (warning)", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "I have read and agree to the CLA" }), { body: "no consent statement here" });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
      expect(out[0]?.severity).toBe("warning");
      expect(out[0]?.detail).toContain('the PR description must contain "I have read and agree to the CLA"');
    });

    it("null/absent body defaults to empty (no crash; the assertion simply fails)", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "agree to the CLA" }), {});
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    });
  });

  describe("check-run-conclusion detection", () => {
    it("a success conclusion satisfies consent", () => {
      expect(evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: "success" })).toEqual([]);
    });

    it("a neutral conclusion also satisfies consent", () => {
      expect(evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: "neutral" })).toEqual([]);
    });

    it("a resolved-but-failing conclusion → cla_consent_missing", () => {
      const out = evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: "failure" });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
      expect(out[0]?.detail).toContain('the "CLA Assistant Lite" check must pass');
    });

    it("a resolved-absent check-run (null, 'no such check-run') → cla_consent_missing, not held", () => {
      const out = evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: null });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    });

    it("an UNRESOLVED conclusion (undefined) with check-run as the ONLY configured method → cla_check_unresolved (HOLD)", () => {
      const out = evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: undefined });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CHECK_UNRESOLVED_CODE);
      expect(out[0]?.severity).toBe("warning");
      expect(out[0]?.title).toContain("CLA Assistant Lite");
    });

    it("omitting checkRunConclusion entirely behaves like undefined (unresolved → HOLD)", () => {
      const out = evaluateClaCheck(config({ checkRunName: "CLA Assistant Lite" }), {});
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CHECK_UNRESOLVED_CODE);
    });
  });

  describe("either-method contract (both configured)", () => {
    it("phrase satisfied, check-run unresolved → satisfied (phrase alone decides; no hold)", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "agree to the CLA", checkRunName: "CLA Assistant Lite" }), {
        body: "I agree to the CLA.",
        checkRunConclusion: undefined,
      });
      expect(out).toEqual([]);
    });

    it("check-run satisfied, phrase missing → satisfied (either method is enough)", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "agree to the CLA", checkRunName: "CLA Assistant Lite" }), {
        body: "no phrase here",
        checkRunConclusion: "success",
      });
      expect(out).toEqual([]);
    });

    it("both fail with the check-run resolved-but-failing → cla_consent_missing lists both, never held", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "agree to the CLA", checkRunName: "CLA Assistant Lite" }), {
        body: "no phrase here",
        checkRunConclusion: "failure",
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
      expect(out[0]?.detail).toContain('the PR description must contain "agree to the CLA"');
      expect(out[0]?.detail).toContain('the "CLA Assistant Lite" check must pass');
    });

    // #2564 gate-review finding: an unresolved check-run must HOLD even when consentPhrase is ALSO configured
    // but not (yet) satisfied — the check-run might still satisfy consent, so a transient GitHub read failure
    // must never hard-fail a PR the check-run method could have saved.
    it("phrase missing, check-run UNRESOLVED → held (cla_check_unresolved), NOT hard-failed — the check-run might still satisfy consent", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "agree to the CLA", checkRunName: "CLA Assistant Lite" }), {
        body: "no phrase here",
        checkRunConclusion: undefined,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CHECK_UNRESOLVED_CODE);
    });
  });

  // #5838: a blank/whitespace-only consentPhrase must be treated as unset, not as an always-matching "" that
  // silently satisfies CLA consent for every PR (`"".includes("")` is unconditionally true).
  describe("empty/whitespace-only consentPhrase normalization (#5838)", () => {
    it("an empty-string consentPhrase does NOT unconditionally satisfy consent — it behaves as if unset", () => {
      const out = evaluateClaCheck(config({ consentPhrase: "", checkRunName: "CLA Assistant Lite" }), {
        body: "no consent statement here",
        checkRunConclusion: "failure",
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
      expect(out[0]?.detail).toContain('the "CLA Assistant Lite" check must pass');
      expect(out[0]?.detail).not.toContain("PR description must contain");
    });

    it("a whitespace-only consentPhrase with no other method configured yields no finding, exactly like null", () => {
      expect(evaluateClaCheck(config({ consentPhrase: "   " }), { body: "anything at all" })).toEqual([]);
    });

    it("REGRESSION: a real non-empty consentPhrase still decides consent (either-method contract unchanged)", () => {
      expect(evaluateClaCheck(config({ consentPhrase: "I agree" }), { body: "... I AGREE ..." })).toEqual([]);
      expect(evaluateClaCheck(config({ consentPhrase: "I agree" }), { body: "nope" })).toHaveLength(1);
    });
  });
});
