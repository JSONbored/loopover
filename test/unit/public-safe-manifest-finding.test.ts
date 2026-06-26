import { describe, expect, it } from "vitest";
import { publicSafeManifestPolicyFinding } from "../../src/queue/processors";
import type { FocusManifestFinding } from "../../src/signals/focus-manifest";

// #1405 / #selfhost-app-id: the focus-manifest policy findings surfaced on the PUBLIC advisory must not echo the
// maintainer's private blocked-path globs or test expectations (which can come from a container-mounted config).
describe("publicSafeManifestPolicyFinding", () => {
  it("redacts the private blocked-path detail to a static phrase, preserving code/severity/title", () => {
    const finding: FocusManifestFinding = {
      code: "manifest_blocked_path",
      severity: "critical",
      title: "Change touches a maintainer-blocked area",
      detail: "Changed paths match maintainer-blocked patterns: secret/private/**, internal/keys/**.",
      action: "Move this work elsewhere — secret/private/** is off-limits.",
    };
    const safe = publicSafeManifestPolicyFinding(finding);
    expect(safe.code).toBe("manifest_blocked_path");
    expect(safe.severity).toBe("critical");
    expect(safe.title).toBe("Change touches a maintainer-blocked area");
    expect(safe.detail).not.toContain("secret/private/**");
    expect(safe.action).not.toContain("secret/private/**");
    expect(safe.detail).toBe("Changed paths match maintainer-blocked areas.");
  });

  it("redacts the private test-expectation detail to a static phrase", () => {
    const finding: FocusManifestFinding = {
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Maintainer test expectations unmet",
      detail: "Maintainer expects test evidence: run the private fuzz suite; hit internal/regression.",
      action: "Add or update tests for the private fuzz suite.",
    };
    const safe = publicSafeManifestPolicyFinding(finding);
    expect(safe.detail).not.toContain("private fuzz suite");
    expect(safe.action).not.toContain("private fuzz suite");
    expect(safe.detail).toBe("Maintainer test expectations are not satisfied by this PR.");
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
