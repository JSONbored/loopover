import { describe, expect, it } from "vitest";

import {
  buildMaintainerSettingsSavePayload,
  MAINTAINER_SETTINGS_EDITABLE_KEYS,
  type MaintainerSettingsEditable,
} from "@/lib/maintainer-settings-editable";

const SETTINGS: MaintainerSettingsEditable = {
  commentMode: "detected_contributors_only",
  publicAudienceMode: "oss_maintainer",
  publicSignalLevel: "standard",
  publicSurface: "comment_and_label",
  checkRunMode: "enabled",
  checkRunDetailLevel: "standard",
  reviewCheckMode: "required",
  gatePack: "gittensor",
  linkedIssueGateMode: "advisory",
  duplicatePrGateMode: "advisory",
  qualityGateMode: "advisory",
  qualityGateMinScore: null,
  mergeReadinessGateMode: "off",
  manifestPolicyGateMode: "off",
  firstTimeContributorGrace: false,
  slopGateMode: "off",
  slopGateMinScore: null,
  slopAiAdvisory: false,
  autoLabelEnabled: true,
  gittensorLabel: "gittensor",
  createMissingLabel: true,
  includeMaintainerAuthors: false,
  requireLinkedIssue: false,
  badgeEnabled: false,
  publicQualityMetrics: false,
  commandAuthorization: {},
  autonomy: {},
  autoMaintain: { requireApprovals: 1, mergeMethod: "squash" },
  agentPaused: false,
  agentDryRun: false,
};

describe("maintainer-settings-editable (#2218)", () => {
  it("buildMaintainerSettingsSavePayload includes every editable key, verbatim, with no patch", () => {
    const payload = buildMaintainerSettingsSavePayload(SETTINGS);
    expect(Object.keys(payload).sort()).toEqual([...MAINTAINER_SETTINGS_EDITABLE_KEYS].sort());
    expect(payload.linkedIssueGateMode).toBe("advisory");
    expect(payload.commentMode).toBe("detected_contributors_only");
  });

  it("buildMaintainerSettingsSavePayload merges a partial patch over the base settings", () => {
    const payload = buildMaintainerSettingsSavePayload(SETTINGS, {
      linkedIssueGateMode: "block",
      duplicatePrGateMode: "block",
    });
    expect(payload.linkedIssueGateMode).toBe("block");
    expect(payload.duplicatePrGateMode).toBe("block");
    // Untouched fields pass through unchanged.
    expect(payload.qualityGateMode).toBe("advisory");
    expect(payload.commentMode).toBe("detected_contributors_only");
  });

  it("an empty patch object is a no-op (same as omitting it)", () => {
    expect(buildMaintainerSettingsSavePayload(SETTINGS, {})).toEqual(
      buildMaintainerSettingsSavePayload(SETTINGS),
    );
  });
});
