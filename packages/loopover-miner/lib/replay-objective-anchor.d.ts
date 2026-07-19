export type ChangeKind = "feature" | "fix" | "refactor" | "docs" | "test" | "chore" | "perf" | "build" | "ci" | "style" | "other";
export declare const CHANGE_KINDS: readonly ChangeKind[];
export declare const MODULE_OVERLAP_WEIGHT = 0.7;
export declare const CHANGE_KIND_WEIGHT = 0.3;
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
export declare function classifyChangeKind(value: unknown): ChangeKind;
export declare function extractReplayTargetFeatures(plan: ReplayPlanInput | null | undefined): ReplayTargetFeatures;
export declare function extractRevealedFeatures(history: readonly unknown[] | RevealedHistoryEntry | null | undefined): RevealedFeatures;
export declare function scoreObjectiveAnchor(replayFeatures: {
    modules?: unknown;
    changeKind?: unknown;
} | null | undefined, revealedFeatures: {
    modules?: unknown;
    changeKinds?: unknown;
} | null | undefined): ObjectiveAnchorBreakdown;
export declare function computeObjectiveAnchor(input: {
    replayPlan?: ReplayPlanInput | null;
    revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
} | null | undefined): ObjectiveAnchorResult;
