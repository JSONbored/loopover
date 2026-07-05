import { describe, expect, it } from "vitest";
import { publicSafeManifestPolicyFinding } from "../../src/queue/processors";
import type { FocusManifestFinding } from "../../src/signals/focus-manifest";

// #1405 / #selfhost-app-id: the focus-manifest policy findings surfaced on the PUBLIC advisory must not echo the
// maintainer's private test expectations (which can come from a container-mounted config).
describe("publicSafeManifestPolicyFinding", () => {
  it("redacts the private test-expectation detail to a static phrase", () => {
    const finding: FocusManifestFinding = {
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Maintainer test expectations unmet",
      detail: "Maintainer expects test evidence: run the private fuzz suite; hit internal/regression.",
      action: "Add or update tests for the private fuzz suite.",
    };
    const safe = publicSafeManifestPolicyFinding(finding);
    expect(safe.title).toBe("Configured validation evidence missing");
    expect(safe.detail).not.toContain("private fuzz suite");
    expect(safe.action).not.toContain("private fuzz suite");
    expect(safe.detail).toBe("No changed test files or passing validation evidence were detected for this PR.");
    expect(safe.action).toBe("Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.");
  });

  it("passes through a finding whose detail is already generic (no override)", () => {
    const finding: FocusManifestFinding = {
      code: "manifest_linked_issue_required",
      severity: "warning",
      title: "Maintainer requires a linked issue",
      detail: "This repo's maintainer focus manifest requires every PR to reference a tracked issue.",
      action: "Link the relevant issue (for example `Closes #123`) before opening the PR.",
    };
    const safe = publicSafeManifestPolicyFinding(finding);
    expect(safe.detail).toBe(finding.detail);
    expect(safe.action).toBe(finding.action);
  });
});
