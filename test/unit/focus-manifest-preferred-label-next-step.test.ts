import { describe, expect, it } from "vitest";
import { buildFocusManifestGuidance, parseFocusManifest } from "../../src/signals/focus-manifest";

function guidance(preferredLabels: string[]) {
  return buildFocusManifestGuidance({
    manifest: parseFocusManifest({ preferredLabels }),
    changedPaths: ["src/example.ts"],
    labels: [],
  });
}

describe("preferred-label public next steps", () => {
  it("keeps the safe preferred labels when the configured list also contains an unsafe label", () => {
    const result = guidance(["bug", "reward payout", "good first issue"]);
    const finding = result.findings.find((entry) => entry.code === "manifest_missing_preferred_label");
    const nextStep = result.publicNextSteps.find((entry) => entry.startsWith("Consider a maintainer-preferred label"));

    expect(finding?.detail).toBe("Maintainer prefers labels: bug, good first issue.");
    expect(nextStep).toBe("Consider a maintainer-preferred label (bug, good first issue).");
    expect(nextStep).not.toMatch(/reward payout/i);
  });

  it("keeps all-safe preferred-label output unchanged", () => {
    const result = guidance(["bug", "enhancement", "good first issue"]);
    const finding = result.findings.find((entry) => entry.code === "manifest_missing_preferred_label");
    const nextStep = result.publicNextSteps.find((entry) => entry.startsWith("Consider a maintainer-preferred label"));

    expect(finding?.detail).toBe("Maintainer prefers labels: bug, enhancement, good first issue.");
    expect(nextStep).toBe("Consider a maintainer-preferred label (bug, enhancement, good first issue).");
  });
});
