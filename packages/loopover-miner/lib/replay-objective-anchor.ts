// Deterministic structural "objective-anchor" score for the historical-replay calibration harness (#3012).
//
// Once a replay run produces a plan/PR against a frozen snapshot, half of the calibration score is meant to
// come from a deterministic, auditable structural comparison rather than an LLM judgment. This module is that
// structural half: it compares what the miner's replayed output *targeted* (modules touched + change kind)
// against what the revealed post-T history *actually* changed, and returns a reproducible `[0, 1]` score plus
// a full audit breakdown. There is no model call in this path — given the same two feature sets it is
// byte-for-byte reproducible.

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

// Fixed change-kind vocabulary. Conventional-Commit types collapse onto these buckets; anything unrecognized
// degrades to "other" so a novel prefix lowers the signal instead of throwing.
export const CHANGE_KINDS: readonly ChangeKind[] = Object.freeze([
  "feature",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
  "perf",
  "build",
  "ci",
  "style",
  "other",
]);

const CONVENTIONAL_TYPE_TO_KIND = new Map<string, ChangeKind>([
  ["feat", "feature"],
  ["feature", "feature"],
  ["fix", "fix"],
  ["bugfix", "fix"],
  ["refactor", "refactor"],
  ["docs", "docs"],
  ["doc", "docs"],
  ["test", "test"],
  ["tests", "test"],
  ["chore", "chore"],
  ["perf", "perf"],
  ["build", "build"],
  ["ci", "ci"],
  ["style", "style"],
]);

// Fixed weights for the two structural components. They sum to 1 so the composed score stays in [0, 1].
export const MODULE_OVERLAP_WEIGHT = 0.7;
export const CHANGE_KIND_WEIGHT = 0.3;

const SCORE_PRECISION = 1e4;

function roundScore(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

// A path's "module" is its directory (everything before the final slash); a bare filename is its own module.
// Grouping by directory is what makes two different files in one directory a *partial* overlap, not a miss.
function pathToModule(path: string): string | null {
  const trimmed = path.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

function normalizeModules(pathsTouched: unknown): string[] {
  if (!Array.isArray(pathsTouched)) return [];
  const modules = new Set<string>();
  for (const entry of pathsTouched) {
    if (typeof entry !== "string") continue;
    const module = pathToModule(entry);
    if (module) modules.add(module);
  }
  return [...modules].sort();
}

function normalizeKindList(value: unknown): ChangeKind[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<ChangeKind>();
  for (const entry of value) {
    if (typeof entry === "string" && isChangeKind(entry)) kinds.add(entry);
  }
  return [...kinds].sort();
}

function isChangeKind(value: string): value is ChangeKind {
  return (CHANGE_KINDS as readonly string[]).includes(value);
}

function normalizeModuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const modules = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry) modules.add(entry);
  }
  return [...modules].sort();
}

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

// Deterministically map a Conventional-Commit-style subject (`feat(scope)!: …`) to a change-kind bucket.
// Missing prefix, unknown type, or non-string input all resolve to "other" rather than throwing.
export function classifyChangeKind(value: unknown): ChangeKind {
  if (typeof value !== "string") return "other";
  const match = /^\s*([A-Za-z]+)\s*(?:\([^)]*\))?\s*!?\s*:/.exec(value);
  if (!match) return "other";
  return CONVENTIONAL_TYPE_TO_KIND.get(match[1]!.toLowerCase()) ?? "other";
}

function resolveChangeKind(entry: { changeKind?: unknown; title?: unknown } | null | undefined): ChangeKind {
  if (entry && typeof entry.changeKind === "string") {
    const explicit = entry.changeKind.trim().toLowerCase();
    if (isChangeKind(explicit)) return explicit;
  }
  return classifyChangeKind(entry?.title);
}

// Structural features of the miner's replayed plan/PR: the sorted, de-duplicated set of modules it targeted
// and its single change kind (explicit `changeKind` wins; otherwise classified from `title`).
export function extractReplayTargetFeatures(plan: ReplayPlanInput | null | undefined): ReplayTargetFeatures {
  return {
    modules: normalizeModules(plan?.pathsTouched),
    changeKind: resolveChangeKind(plan),
  };
}

// Structural features of the revealed post-T history. The history is a list of commits/PRs (a single object
// is tolerated as a one-element list); modules are unioned and change kinds collected into a set, since the
// revealed side legitimately spans several changes.
export function extractRevealedFeatures(history: readonly unknown[] | RevealedHistoryEntry | null | undefined): RevealedFeatures {
  const entries: unknown[] = Array.isArray(history) ? history : history ? [history] : [];
  const modules = new Set<string>();
  const changeKinds = new Set<ChangeKind>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as RevealedHistoryEntry;
    for (const module of normalizeModules(record.pathsTouched)) modules.add(module);
    changeKinds.add(resolveChangeKind(record));
  }
  return {
    modules: [...modules].sort(),
    changeKinds: [...changeKinds].sort(),
  };
}

// Deterministic objective-anchor score from two already-extracted feature sets. No LLM, no clock, no
// randomness — identical inputs always yield an identical breakdown. A zero-overlap comparison (disjoint
// modules and a change kind the revealed side never shows) resolves to the score floor `0`, never an error.
export function scoreObjectiveAnchor(
  replayFeatures: { modules?: unknown; changeKind?: unknown } | null | undefined,
  revealedFeatures: { modules?: unknown; changeKinds?: unknown } | null | undefined,
): ObjectiveAnchorBreakdown {
  const replayModules = normalizeModuleList(replayFeatures?.modules);
  const revealedModules = normalizeModuleList(revealedFeatures?.modules);
  const replayChangeKind =
    typeof replayFeatures?.changeKind === "string" && isChangeKind(replayFeatures.changeKind)
      ? replayFeatures.changeKind
      : "other";
  const revealedChangeKinds = normalizeKindList(revealedFeatures?.changeKinds);

  const replaySet = new Set(replayModules);
  const revealedSet = new Set(revealedModules);
  const sharedModules = replayModules.filter((module) => revealedSet.has(module));
  const replayOnlyModules = replayModules.filter((module) => !revealedSet.has(module));
  const revealedOnlyModules = revealedModules.filter((module) => !replaySet.has(module));

  const unionSize = replayModules.length + revealedModules.length - sharedModules.length;
  const moduleOverlap = unionSize === 0 ? 0 : sharedModules.length / unionSize;
  const changeKindMatch: 0 | 1 = revealedChangeKinds.includes(replayChangeKind) ? 1 : 0;

  return {
    score: roundScore(MODULE_OVERLAP_WEIGHT * moduleOverlap + CHANGE_KIND_WEIGHT * changeKindMatch),
    moduleOverlap: roundScore(moduleOverlap),
    changeKindMatch,
    replayChangeKind,
    revealedChangeKinds,
    sharedModules,
    replayOnlyModules,
    revealedOnlyModules,
  };
}

// One-shot entry point: extract both sides, score them, and return the score together with the extracted
// feature sets so a low score is auditable after the fact without re-running the extraction.
export function computeObjectiveAnchor(
  input:
    | {
        replayPlan?: ReplayPlanInput | null;
        revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
      }
    | null
    | undefined,
): ObjectiveAnchorResult {
  const replayFeatures = extractReplayTargetFeatures(input?.replayPlan);
  const revealedFeatures = extractRevealedFeatures(input?.revealedHistory);
  return {
    ...scoreObjectiveAnchor(replayFeatures, revealedFeatures),
    replayFeatures,
    revealedFeatures,
  };
}
