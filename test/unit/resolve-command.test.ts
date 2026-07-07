import { describe, expect, it } from "vitest";
import { normalizeResolveFindingRef } from "../../src/github/resolve-command";

describe("normalizeResolveFindingRef (#2166)", () => {
  it("treats empty/absent trailing text as a whole-PR ack", () => {
    expect(normalizeResolveFindingRef(undefined)).toEqual({ ok: true, scope: "whole_pr" });
    expect(normalizeResolveFindingRef("")).toEqual({ ok: true, scope: "whole_pr" });
    expect(normalizeResolveFindingRef("   ")).toEqual({ ok: true, scope: "whole_pr" });
  });

  it("accepts a bare finding code and the optional finding- prefix", () => {
    expect(normalizeResolveFindingRef("missing_linked_issue")).toEqual({
      ok: true,
      scope: "single",
      findingCode: "missing_linked_issue",
    });
    expect(normalizeResolveFindingRef("finding-missing_linked_issue")).toEqual({
      ok: true,
      scope: "single",
      findingCode: "missing_linked_issue",
    });
  });

  it("rejects malformed finding references", () => {
    expect(normalizeResolveFindingRef("../escape")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("Bad-Hyphen")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("has space")).toEqual({ ok: false, reason: "malformed_finding_id" });
    expect(normalizeResolveFindingRef("9starts_with_digit")).toEqual({ ok: false, reason: "malformed_finding_id" });
  });
});
