export type ChangeKind =
  | "feature"
  | "fix"
  | "refactor"
  | "docs"
  | "test"
  | "chore"
  | "perf"
  | "build"
  | "ci"
  | "style"
  | "other";

export const CHANGE_KINDS: readonly ChangeKind[];
export const MODULE_OVERLAP_WEIGHT: number;
export const CHANGE_KIND_WEIGHT: number;

export type ReplayPlanInput = {
  pathsTouched?: unknown;
  changeKind?: unknown;
  title?: unknown;
};

export type RevealedHistoryEntry = {
  pathsTouched?: unknown;
  changeKind?: unknown;
  title?: unknown;
};

export type ReplayTargetFeatures = {
  modules: string[];
  changeKind: ChangeKind;
};

export type RevealedFeatures = {
  modules: string[];
  changeKinds: ChangeKind[];
};

export type ObjectiveAnchorBreakdown = {
  score: number;
  moduleOverlap: number;
  changeKindMatch: 0 | 1;
  replayChangeKind: ChangeKind;
  revealedChangeKinds: ChangeKind[];
  sharedModules: string[];
  replayOnlyModules: string[];
  revealedOnlyModules: string[];
};

export type ObjectiveAnchorResult = ObjectiveAnchorBreakdown & {
  replayFeatures: ReplayTargetFeatures;
  revealedFeatures: RevealedFeatures;
};

export function classifyChangeKind(value: unknown): ChangeKind;

export function extractReplayTargetFeatures(
  plan: ReplayPlanInput | null | undefined,
): ReplayTargetFeatures;

export function extractRevealedFeatures(
  history: readonly unknown[] | RevealedHistoryEntry | null | undefined,
): RevealedFeatures;

export function scoreObjectiveAnchor(
  replayFeatures: { modules?: unknown; changeKind?: unknown } | null | undefined,
  revealedFeatures: { modules?: unknown; changeKinds?: unknown } | null | undefined,
): ObjectiveAnchorBreakdown;

export function computeObjectiveAnchor(
  input:
    | {
        replayPlan?: ReplayPlanInput | null;
        revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
      }
    | null
    | undefined,
): ObjectiveAnchorResult;
