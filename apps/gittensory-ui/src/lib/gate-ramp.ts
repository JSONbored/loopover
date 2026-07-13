/**
 * Advisory → blocking ramp helpers for the maintainer onboarding surface (#2218). Mirrors the deterministic
 * gate trio that `ActivationPreview`'s POST /activation enables in advisory mode; blocking ramps those same
 * fields to `block` via the existing PUT /settings merge path (maintainer-settings.tsx).
 */

import type { GateMode } from "@/lib/maintainer-settings-editable";

export type { GateMode };

/** The three deterministic sub-gates flipped together during the ramp. */
export const RAMP_DETERMINISTIC_GATE_KEYS = [
  "linkedIssueGateMode",
  "duplicatePrGateMode",
  "qualityGateMode",
] as const;

export type RampDeterministicGateKey = (typeof RAMP_DETERMINISTIC_GATE_KEYS)[number];

export type GateRampSettingsSlice = {
  // #4618/#5373: reviewCheckMode is the sole writable authority for whether the check-run publishes at
  // all (the "disabled" | "visible" | "required" trio) -- the prior computed gateCheckMode field this
  // helper set once mirrored has since been removed entirely, so ramp activity is gated on this alone.
  reviewCheckMode: "required" | "visible" | "disabled";
} & Record<RampDeterministicGateKey, GateMode>;

export type GateRampPhase = "inactive" | "advisory" | "blocking";

export type GateRampSummary = {
  phase: GateRampPhase;
  /** Human label for the ramp pill (inactive / advisory / blocking). */
  label: string;
  /** Short helper copy under the switch. */
  description: string;
  /** Whether the maintainer can attempt the advisory → blocking transition. */
  canRampToBlocking: boolean;
  /** Whether blocking is already fully engaged for the ramp trio. */
  isBlocking: boolean;
};

const PHASE_LABEL: Record<GateRampPhase, string> = {
  inactive: "Gate off",
  advisory: "Advisory",
  blocking: "Blocking",
};

const PHASE_DESCRIPTION: Record<GateRampPhase, string> = {
  inactive:
    "Enable advisory mode in the activation preview above before ramping deterministic rules to blocking.",
  advisory:
    "Deterministic linked-issue, duplicate-PR, and quality gates surface guidance without blocking merges. Flip to blocking when you are ready to enforce.",
  blocking:
    "Linked-issue, duplicate-PR, and quality gates can block merges when findings fire. Re-tune individual gates in repository settings below.",
};

/** Whether the Gittensory review-agent check is actively publishing at all. */
export function isGateRampActive(settings: GateRampSettingsSlice): boolean {
  return settings.reviewCheckMode !== "disabled";
}

/** True when every ramp deterministic sub-gate is set to block. */
export function isBlockingRampComplete(settings: GateRampSettingsSlice): boolean {
  return RAMP_DETERMINISTIC_GATE_KEYS.every((key) => settings[key] === "block");
}

/** Derive the maintainer-facing ramp phase from loaded repository settings. */
export function deriveGateRampPhase(settings: GateRampSettingsSlice): GateRampPhase {
  if (!isGateRampActive(settings)) return "inactive";
  if (isBlockingRampComplete(settings)) return "blocking";
  return "advisory";
}

export function summarizeGateRamp(settings: GateRampSettingsSlice): GateRampSummary {
  const phase = deriveGateRampPhase(settings);
  const isBlocking = phase === "blocking";
  return {
    phase,
    label: PHASE_LABEL[phase],
    description: PHASE_DESCRIPTION[phase],
    canRampToBlocking: phase === "advisory",
    isBlocking,
  };
}

/** Patch applied on confirm: only the ramp trio moves to block; everything else is preserved by PUT merge. */
export function buildBlockingRampPatch(): Pick<GateRampSettingsSlice, RampDeterministicGateKey> {
  return {
    linkedIssueGateMode: "block",
    duplicatePrGateMode: "block",
    qualityGateMode: "block",
  };
}

/** List gate keys that would change when ramping (for confirm-dialog copy). */
export function listRampGateTransitions(
  settings: GateRampSettingsSlice,
): Array<{ key: RampDeterministicGateKey; from: GateMode; to: GateMode }> {
  const patch = buildBlockingRampPatch();
  return RAMP_DETERMINISTIC_GATE_KEYS.map((key) => ({
    key,
    from: settings[key],
    to: patch[key],
  })).filter((entry) => entry.from !== entry.to);
}

/** Friendly labels for confirm-dialog rows. */
export const RAMP_GATE_DISPLAY_LABELS: Record<RampDeterministicGateKey, string> = {
  linkedIssueGateMode: "Linked issue gate",
  duplicatePrGateMode: "Duplicate PR gate",
  qualityGateMode: "Quality / readiness gate",
};
