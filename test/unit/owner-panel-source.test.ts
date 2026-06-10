import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ownerPanelSource = readFileSync(
  "apps/gittensory-ui/src/components/site/app-panels/owner-panel.tsx",
  "utf8",
);

describe("owner panel workflow surface", () => {
  it("renders the guided owner workflow as the primary section", () => {
    expect(ownerPanelSource).toContain("Guided owner workflow");
    expect(ownerPanelSource).toContain("Next owner actions");
    expect(ownerPanelSource).toContain("Supporting readiness signals");
  });

  it("shows workflow bucket state pills and remediation labels", () => {
    expect(ownerPanelSource).toContain("formatWorkflowState");
    expect(ownerPanelSource).toContain("Manual follow-up");
    expect(ownerPanelSource).toContain('item.remediationKind === "manual" ? "Manual follow-up" : "Action"');
  });
});
