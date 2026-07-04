export const FORWARD_REF_PLACEHOLDER: string;

export type RecencyPool = "recent" | "older";
export const RECENCY_POOLS: readonly RecencyPool[];

export type ForwardReference = {
  kind: "link" | "hashref" | "sha" | "bare-issue-number";
  value: string | number;
};

export type ForwardRefContext = {
  knownIssueMax?: number;
  knownCommitShas?: string[];
  revealedIssueNumbers?: number[];
};

export type DetectedForwardReferences = {
  scrubbable: ForwardReference[];
  unscrubbable: ForwardReference[];
};

export type ScrubResult = {
  scrubbed: string;
  removed: ForwardReference[];
  residual: ForwardReference[];
};

export type LintResult = {
  ok: boolean;
  residual: ForwardReference[];
};

export type FreezePointThresholds = {
  minPriorCommits?: number;
  minRevealedCommits?: number;
};

export type FreezePointCandidate = {
  repo?: string;
  commitT?: string;
  priorCommitCount?: number;
  revealedCommitCount?: number;
  lastActivityAt?: string;
  frozenContextTexts?: unknown[];
  revealedGroundTruth?: unknown;
};

export type FreezePointSelection = {
  eligible: boolean;
  reasons: string[];
  priorCommitCount: number;
  revealedCommitCount: number;
};

export type ReplayTaskOptions = {
  thresholds?: FreezePointThresholds;
  modelCutoffIso?: string;
};

export type ReplayTaskRejected = {
  eligible: false;
  rejected: "selection" | "unscrubbable_forward_reference";
  reasons?: string[];
  residual?: ForwardReference[];
};

export type ReplayTask = {
  eligible: true;
  pool: RecencyPool;
  frozen: {
    repo: string | null;
    commitT: string | null;
    contextTexts: string[];
  };
  revealed: {
    commitCount: number;
    groundTruth: unknown;
  };
};

export function detectForwardReferences(
  text: unknown,
  context: ForwardRefContext | null | undefined,
): DetectedForwardReferences;

export function scrubForwardReferences(
  text: unknown,
  context: ForwardRefContext | null | undefined,
): ScrubResult;

export function lintFrozenContext(
  texts: unknown,
  context: ForwardRefContext | null | undefined,
): LintResult;

export function selectFreezePoint(
  candidate: FreezePointCandidate | null | undefined,
  thresholds: FreezePointThresholds | null | undefined,
): FreezePointSelection;

export function classifyRecencyPool(
  candidate: FreezePointCandidate | null | undefined,
  options: { modelCutoffIso?: string } | null | undefined,
): RecencyPool;

export function generateReplayTask(
  candidate: FreezePointCandidate | null | undefined,
  context: ForwardRefContext | null | undefined,
  options: ReplayTaskOptions | null | undefined,
): ReplayTask | ReplayTaskRejected;
