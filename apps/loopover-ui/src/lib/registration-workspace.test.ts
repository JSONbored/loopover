import { describe, expect, it } from "vitest";

import { workflowHeadline } from "@/lib/registration-workspace";

describe("workflowHeadline (#7535)", () => {
  it("reports Accepted when the buckets are clear and readiness is ready", () => {
    expect(workflowHeadline("accepted", true)).toBe(
      "Accepted — contributor intake posture matches the recommended registration mode.",
    );
  });

  it("does not contradict the Accepted pill when accepted but readiness is false", () => {
    // overallState is "accepted" (every bucket clear) so the pill above the headline reads "Accepted";
    // the headline must not fall through to the generic "Needs cleanup" copy, which would both contradict
    // the pill and imply an actionable bucket item exists when none does.
    const headline = workflowHeadline("accepted", false);
    expect(headline).toBe(
      "Accepted — the workflow buckets are all clear, but an overall readiness check outside them is still blocking; resolve it before scaling intake.",
    );
    expect(headline.startsWith("Accepted")).toBe(true);
    expect(headline).not.toContain("Needs cleanup");
  });

  it("reports Not ready for the not_ready state regardless of readiness", () => {
    const expected =
      "Not ready — resolve blockers in the workflow buckets before inviting more contributors.";
    expect(workflowHeadline("not_ready", false)).toBe(expected);
    expect(workflowHeadline("not_ready", true)).toBe(expected);
  });

  it("reports Needs cleanup only for the needs_cleanup state", () => {
    const expected =
      "Needs cleanup — some areas are acceptable but require maintainer follow-up before scaling intake.";
    expect(workflowHeadline("needs_cleanup", false)).toBe(expected);
    expect(workflowHeadline("needs_cleanup", true)).toBe(expected);
  });
});
