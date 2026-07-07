import { describe, expect, it } from "vitest";
import { normalizeResolveFindingRef, selectWarningsForResolve } from "../../src/review/review-memory-wire";
import type { AdvisoryFinding } from "../../src/types";

function warning(overrides: Partial<AdvisoryFinding> = {}): AdvisoryFinding {
  return {
    code: "readiness_score_below_threshold",
    severity: "warning",
    title: "Readiness score is below the configured threshold",
    detail: "The public readiness score is 25/100, below the repository threshold of 100/100.",
    ...overrides,
  };
}

describe("normalizeResolveFindingRef (#1964)", () => {
  it("treats empty/absent trailing text as a whole-PR ack", () => {
    expect(normalizeResolveFindingRef(undefined)).toEqual({ ok: true, scope: "whole_pr" });
    expect(normalizeResolveFindingRef("")).toEqual({ ok: true, scope: "whole_pr" });
    expect(normalizeResolveFindingRef("   ")).toEqual({ ok: true, scope: "whole_pr" });
  });

  it("accepts a bare finding code and the optional finding- prefix", () => {
    expect(normalizeResolveFindingRef("readiness_score_below_threshold")).toEqual({
      ok: true,
      scope: "single",
      findingCode: "readiness_score_below_threshold",
    });
    expect(normalizeResolveFindingRef("finding-readiness_score_below_threshold")).toEqual({
      ok: true,
      scope: "single",
      findingCode: "readiness_score_below_threshold",
    });
  });

  it("rejects malformed finding references", () => {
    expect(normalizeResolveFindingRef("../escape")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("Bad-Hyphen")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("has space")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("9starts_with_digit")).toEqual({ ok: false, reason: "malformed_finding_id" });
  });
});

describe("selectWarningsForResolve (#1964)", () => {
  it("returns every warning for a whole-PR ack", () => {
    const warnings = [warning(), warning({ code: "duplicate_pr_risk", title: "Duplicate risk" })];
    expect(selectWarningsForResolve(warnings, { ok: true, scope: "whole_pr" })).toEqual({ findings: warnings });
  });

  it("returns only the matching warning for a single-finding ref", () => {
    const a = warning();
    const b = warning({ code: "duplicate_pr_risk", title: "Duplicate risk" });
    expect(selectWarningsForResolve([a, b], { ok: true, scope: "single", findingCode: "duplicate_pr_risk" })).toEqual({
      findings: [b],
    });
  });

  it("reports finding_not_found when the requested code is absent from the warnings", () => {
    expect(
      selectWarningsForResolve([warning()], { ok: true, scope: "single", findingCode: "missing_linked_issue" }),
    ).toEqual({ findings: [], reason: "finding_not_found" });
  });
});
