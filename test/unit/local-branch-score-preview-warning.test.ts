import { describe, expect, it } from "vitest";
import { __localBranchInternals } from "../../src/signals/local-branch";

describe("score preview warning severity", () => {
  it.each([
    "token gate is not satisfied",
    "confirmed ineligible for this branch",
    "contributor is not registered",
    "no active registration",
    "open PR count exceeds the threshold",
    "credibility is below the required floor",
  ])("classifies blocking warning text as warning: %s", (warning) => {
    expect(__localBranchInternals.scorePreviewWarningFinding(warning)).toMatchObject({
      code: "score_preview_warning",
      severity: "warning",
      detail: warning,
    });
  });

  it("keeps unrelated preview warnings informational", () => {
    expect(__localBranchInternals.scorePreviewWarningFinding("Mirror data is still warming up")).toMatchObject({
      code: "score_preview_warning",
      severity: "info",
    });
  });
});
