/**
 * The maintainer-editable repository settings shape, centralized so `maintainer-settings.tsx`'s full editor
 * and `gate-ramp-control.tsx`'s one-click ramp control (#2218) share one PUT /settings payload builder
 * instead of two independently-maintained `EDITABLE_KEYS` lists drifting apart.
 */

export type GateMode = "off" | "advisory" | "block";
export type CommandRole = "maintainer" | "collaborator" | "pr_author" | "confirmed_miner";

export type CommandAuthorization = {
  default?: CommandRole[];
  commands?: Record<string, CommandRole[]>;
};

export type AutonomyLevel = "observe" | "auto_with_approval" | "auto";
export type AgentActionClass =
  "review" | "request_changes" | "approve" | "merge" | "close" | "label";

export type MaintainerSettingsEditable = {
  // #4618/#5373: a prior gateCheckMode field was a deprecated computed read-back, since removed entirely --
  // reviewCheckMode is the real, writable authority for whether the review-agent check-run publishes.
  reviewCheckMode: "required" | "visible" | "disabled";
  gatePack: "gittensor" | "oss-anti-slop";
  linkedIssueGateMode: GateMode;
  duplicatePrGateMode: GateMode;
  qualityGateMode: GateMode;
  qualityGateMinScore: number | null;
  mergeReadinessGateMode: GateMode;
  manifestPolicyGateMode: GateMode;
  firstTimeContributorGrace: boolean;
  slopGateMode: GateMode;
  slopGateMinScore: number | null;
  slopAiAdvisory: boolean;
  autoLabelEnabled: boolean;
  // #6443: gittensorLabel/createMissingLabel removed -- no longer DB-backed, config-as-code only via
  // .loopover.yml's settings: block now (the dashboard can no longer write them).
  requireLinkedIssue: boolean;
  commandAuthorization: CommandAuthorization;
  autonomy: Partial<Record<AgentActionClass, AutonomyLevel>>;
  // #6445: autoMaintain removed -- no longer DB-backed, config-as-code only via .loopover.yml's
  // settings: block now (the dashboard can no longer write it).
  agentPaused: boolean;
  agentDryRun: boolean;
};

// The maintainer-editable subset, sent verbatim to PUT /settings (which merges onto current settings).
export const MAINTAINER_SETTINGS_EDITABLE_KEYS: Array<keyof MaintainerSettingsEditable> = [
  "reviewCheckMode",
  "gatePack",
  "linkedIssueGateMode",
  "duplicatePrGateMode",
  "qualityGateMode",
  "qualityGateMinScore",
  "mergeReadinessGateMode",
  "manifestPolicyGateMode",
  "firstTimeContributorGrace",
  "slopGateMode",
  "slopGateMinScore",
  "slopAiAdvisory",
  "autoLabelEnabled",
  "requireLinkedIssue",
  "commandAuthorization",
  "autonomy",
  "agentPaused",
  "agentDryRun",
];

/**
 * Build the PUT /settings body: every editable key from `settings`, with `patch` merged on top so a caller
 * (e.g. the gate-ramp control) can flip a handful of fields without hand-copying the other ~25.
 */
export function buildMaintainerSettingsSavePayload(
  settings: MaintainerSettingsEditable,
  patch: Partial<MaintainerSettingsEditable> = {},
): Record<string, unknown> {
  const merged = { ...settings, ...patch };
  return Object.fromEntries(MAINTAINER_SETTINGS_EDITABLE_KEYS.map((key) => [key, merged[key]]));
}
