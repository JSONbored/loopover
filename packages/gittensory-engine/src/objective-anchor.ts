// Deterministic objective-anchor scoring for historical replay calibration (#3012).
//
// The replay harness needs a stable, auditable score before any LLM judge is involved: compare what the miner
// planned or changed against what the revealed post-T history actually changed. This module is deliberately pure:
// no IO, no Date, no random, no model calls. Given the same replayed and revealed records, it returns the same
// normalized features, dimension scores, composite score, and audit payload byte-for-byte.

export type ObjectiveAnchorChangeKind =
  | "feature"
  | "fix"
  | "test"
  | "docs"
  | "refactor"
  | "config"
  | "ci"
  | "security"
  | "dependency"
  | "unknown";

export type ObjectiveAnchorInput = {
  /** Paths touched or explicitly targeted by a replayed plan/PR or by revealed history. */
  paths?: readonly string[] | undefined;
  /** Labels from an issue, PR, or local candidate record. Used only for change-kind extraction. */
  labels?: readonly string[] | undefined;
  /** Titles or short subjects. Used only for change-kind extraction. */
  titles?: readonly string[] | undefined;
  /** Longer plan/review/commit notes. Used only for change-kind extraction. */
  notes?: readonly string[] | undefined;
  /** Optional already-classified kinds from an upstream caller. */
  changeKinds?: readonly ObjectiveAnchorChangeKind[] | undefined;
};

export type ObjectiveAnchorHistoryItem = ObjectiveAnchorInput & {
  /** Stable caller-side identifier, e.g. `plan:abc`, `pr:123`, or `commit:deadbeef`. */
  id?: string | undefined;
  /** Human-readable source bucket for audit reports. */
  source?: "plan" | "pull_request" | "commit" | "issue" | "manual" | "unknown" | undefined;
};

export type ObjectiveAnchorFeatures = {
  /** Stable, normalized file paths with duplicates removed. */
  paths: string[];
  /** Coarse module buckets derived from paths, e.g. `src/review`, `packages/gittensory-engine`, `docs`. */
  modules: string[];
  /** Inferred or caller-supplied change kinds with duplicates removed. */
  changeKinds: ObjectiveAnchorChangeKind[];
};

export type ObjectiveAnchorHistoryItemAudit = {
  id: string;
  source: NonNullable<ObjectiveAnchorHistoryItem["source"]>;
  features: ObjectiveAnchorFeatures;
};

export type ObjectiveAnchorHistoryExtraction = {
  features: ObjectiveAnchorFeatures;
  items: ObjectiveAnchorHistoryItemAudit[];
};

export type ObjectiveAnchorWeights = {
  /** Weight for exact/tight path overlap. Default: 0.45. */
  paths?: number | undefined;
  /** Weight for coarser module overlap. Default: 0.4. */
  modules?: number | undefined;
  /** Weight for change-kind overlap. Default: 0.15. */
  changeKinds?: number | undefined;
};

type NormalizedObjectiveAnchorWeights = {
  paths: number;
  modules: number;
  changeKinds: number;
};

export type ObjectiveAnchorDimensionScores = {
  paths: number;
  modules: number;
  changeKinds: number;
};

export type ObjectiveAnchorAudit = {
  replayed: ObjectiveAnchorFeatures;
  revealed: ObjectiveAnchorFeatures;
  weights: NormalizedObjectiveAnchorWeights;
  dimensions: ObjectiveAnchorDimensionScores;
  intersections: {
    paths: string[];
    modules: string[];
    changeKinds: ObjectiveAnchorChangeKind[];
  };
  misses: {
    replayedOnlyPaths: string[];
    revealedOnlyPaths: string[];
    replayedOnlyModules: string[];
    revealedOnlyModules: string[];
    replayedOnlyChangeKinds: ObjectiveAnchorChangeKind[];
    revealedOnlyChangeKinds: ObjectiveAnchorChangeKind[];
  };
};

export type ObjectiveAnchorScore = {
  /** Composite score in [0, 1]. */
  score: number;
  dimensions: ObjectiveAnchorDimensionScores;
  audit: ObjectiveAnchorAudit;
};

export type ObjectiveAnchorHistoryScore = ObjectiveAnchorScore & {
  history: {
    replayed: ObjectiveAnchorHistoryExtraction;
    revealed: ObjectiveAnchorHistoryExtraction;
  };
};

const DEFAULT_WEIGHTS: NormalizedObjectiveAnchorWeights = {
  paths: 0.45,
  modules: 0.4,
  changeKinds: 0.15,
};

const CHANGE_KIND_ORDER: ObjectiveAnchorChangeKind[] = [
  "feature",
  "fix",
  "test",
  "docs",
  "refactor",
  "config",
  "ci",
  "security",
  "dependency",
  "unknown",
];

const KIND_SYNONYMS: Array<[ObjectiveAnchorChangeKind, RegExp]> = [
  ["feature", /\b(feat|feature|enhancement|add|adds|introduce|support|capability)\b/iu],
  ["fix", /\b(fix|bug|bugfix|regression|repair|broken|incorrect|failure|fails?)\b/iu],
  ["test", /\b(test|tests|coverage|regression-test|vitest|unit|integration)\b/iu],
  ["docs", /\b(doc|docs|readme|documentation|guide|quickstart|manual)\b/iu],
  ["refactor", /\b(refactor|cleanup|simplify|extract|rename|restructure)\b/iu],
  ["config", /\b(config|configuration|settings|env|schema|yaml|jsonc|wrangler|toml)\b/iu],
  ["ci", /\b(ci|workflow|github-actions|actionlint|codecov|pipeline|build)\b/iu],
  ["security", /\b(security|secret|token|credential|auth|permission|vulnerability|cve)\b/iu],
  ["dependency", /\b(dependency|dependencies|deps|package-lock|npm|pnpm|yarn|version|upgrade|pin)\b/iu],
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const CI_SEGMENTS = new Set([".github", "workflows"]);
const CONFIG_FILENAMES = new Set([
  ".env",
  ".env.example",
  ".env.selfhost.example",
  ".loopover.yml", // new-brand manifest name (legacy .gittensory.yml kept below, dual-read indefinitely, #4773)
  ".gittensory.yml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "wrangler.jsonc",
  "vite.config.ts",
  "vitest.config.ts",
]);

function normalizePath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized.includes("\0")) return undefined;
  return normalized.toLowerCase();
}

function extensionOf(path: string): string {
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot <= 0 ? "" : last.slice(dot);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueKinds(kinds: Iterable<ObjectiveAnchorChangeKind>): ObjectiveAnchorChangeKind[] {
  const seen = new Set(kinds);
  return CHANGE_KIND_ORDER.filter((kind) => seen.has(kind));
}

function combineFeatures(features: readonly ObjectiveAnchorFeatures[]): ObjectiveAnchorFeatures {
  return {
    paths: uniqueSorted(features.flatMap((feature) => feature.paths)),
    modules: uniqueSorted(features.flatMap((feature) => feature.modules)),
    changeKinds: uniqueKinds(features.flatMap((feature) => feature.changeKinds)),
  };
}

function isKnownKind(kind: string): kind is ObjectiveAnchorChangeKind {
  return (CHANGE_KIND_ORDER as string[]).includes(kind);
}

function normalizeKind(value: string): ObjectiveAnchorChangeKind | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/gu, "-");
  if (isKnownKind(normalized)) return normalized;
  if (normalized === "feat" || normalized === "enhancement") return "feature";
  if (normalized === "bug" || normalized === "bugfix" || normalized === "regression") return "fix";
  if (normalized === "documentation" || normalized === "readme") return "docs";
  if (normalized === "build" || normalized === "workflow") return "ci";
  if (normalized === "deps" || normalized === "package") return "dependency";
  return undefined;
}

function pathModule(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "root";
  const [first, second] = segments;
  if (first === "packages" || first === "apps") {
    return second ? `${first}/${second}` : first;
  }
  if (first === "src" || first === "test" || first === "tests") {
    return second ? `${first}/${second}` : first;
  }
  if (first === ".github") return segments[1] === "workflows" ? ".github/workflows" : ".github";
  return first!;
}

function kindsFromPath(path: string): ObjectiveAnchorChangeKind[] {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? path;
  const kinds: ObjectiveAnchorChangeKind[] = [];
  if (segments.some((segment) => TEST_SEGMENTS.has(segment)) || /\.test\.|\.spec\./u.test(filename)) {
    kinds.push("test");
  }
  if (DOC_EXTENSIONS.has(extensionOf(path)) || segments.includes("docs") || filename.toLowerCase() === "readme.md") {
    kinds.push("docs");
  }
  if (segments.some((segment) => CI_SEGMENTS.has(segment)) || filename.endsWith(".yml") || filename.endsWith(".yaml")) {
    kinds.push("ci");
  }
  if (CONFIG_FILENAMES.has(filename) || filename.endsWith(".jsonc") || filename.endsWith(".toml")) {
    kinds.push("config");
  }
  if (/package(?:-lock)?\.json$/u.test(filename)) {
    kinds.push("dependency");
  }
  return kinds;
}

function kindsFromText(values: readonly string[] | undefined): ObjectiveAnchorChangeKind[] {
  if (!values) return [];
  const kinds: ObjectiveAnchorChangeKind[] = [];
  for (const value of values) {
    for (const explicit of value.split(/[,\s/()[\]{}:;]+/u)) {
      const normalized = normalizeKind(explicit);
      if (normalized) kinds.push(normalized);
    }
    for (const [kind, pattern] of KIND_SYNONYMS) {
      if (pattern.test(value)) kinds.push(kind);
    }
  }
  return kinds;
}

function normalizeWeights(weights: ObjectiveAnchorWeights | undefined): NormalizedObjectiveAnchorWeights {
  const raw = {
    paths: finiteNonNegative(weights?.paths, DEFAULT_WEIGHTS.paths),
    modules: finiteNonNegative(weights?.modules, DEFAULT_WEIGHTS.modules),
    changeKinds: finiteNonNegative(weights?.changeKinds, DEFAULT_WEIGHTS.changeKinds),
  };
  const total = raw.paths + raw.modules + raw.changeKinds;
  if (total <= 0) return DEFAULT_WEIGHTS;
  return {
    paths: raw.paths / total,
    modules: raw.modules / total,
    changeKinds: raw.changeKinds / total,
  };
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function diceOverlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const intersection = left.filter((value) => rightSet.has(value)).length;
  return (2 * intersection) / (left.length + right.length);
}

function intersectStrings(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function differenceStrings(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function intersectKinds(
  left: readonly ObjectiveAnchorChangeKind[],
  right: readonly ObjectiveAnchorChangeKind[],
): ObjectiveAnchorChangeKind[] {
  const rightSet = new Set(right);
  return CHANGE_KIND_ORDER.filter((kind) => left.includes(kind) && rightSet.has(kind));
}

function differenceKinds(
  left: readonly ObjectiveAnchorChangeKind[],
  right: readonly ObjectiveAnchorChangeKind[],
): ObjectiveAnchorChangeKind[] {
  const rightSet = new Set(right);
  return CHANGE_KIND_ORDER.filter((kind) => left.includes(kind) && !rightSet.has(kind));
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function auditItemId(item: ObjectiveAnchorHistoryItem, index: number): string {
  const trimmed = item.id?.trim();
  return trimmed ? trimmed : `item:${index + 1}`;
}

function auditItemSource(item: ObjectiveAnchorHistoryItem): NonNullable<ObjectiveAnchorHistoryItem["source"]> {
  return item.source ?? "unknown";
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

function markdownKindList(values: readonly ObjectiveAnchorChangeKind[]): string {
  return markdownList(values);
}

function markdownFeatureBlock(features: ObjectiveAnchorFeatures): string {
  return [
    "Paths:",
    markdownList(features.paths),
    "",
    "Modules:",
    markdownList(features.modules),
    "",
    "Change kinds:",
    markdownKindList(features.changeKinds),
  ].join("\n");
}

function markdownHistoryBlock(extraction: ObjectiveAnchorHistoryExtraction): string {
  if (extraction.items.length === 0) return "_No history items._";
  return extraction.items
    .map((item) =>
      [
        `### ${markdownSafe(item.id)} (${markdownSafe(item.source)})`,
        "",
        markdownFeatureBlock(item.features),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Extract normalized structural features from replayed or revealed history input. The extractor is intentionally
 * conservative: paths determine modules, and labels/titles/notes only classify change kind. It never guesses a
 * module from free text, which keeps the path/module score auditable and reproducible.
 */
export function extractObjectiveAnchorFeatures(input: ObjectiveAnchorInput): ObjectiveAnchorFeatures {
  const paths = uniqueSorted((input.paths ?? []).map(normalizePath).filter((path): path is string => Boolean(path)));
  const modules = uniqueSorted(paths.map(pathModule));
  const directKinds = (input.changeKinds ?? []).filter((kind): kind is ObjectiveAnchorChangeKind => isKnownKind(kind));
  const textKinds = kindsFromText([...(input.labels ?? []), ...(input.titles ?? []), ...(input.notes ?? [])]);
  const pathKinds = paths.flatMap(kindsFromPath);
  const changeKinds = uniqueKinds([...directKinds, ...textKinds, ...pathKinds]);
  return {
    paths,
    modules,
    changeKinds: changeKinds.length > 0 ? changeKinds : ["unknown"],
  };
}

/**
 * Extract and aggregate structural features from a replay/revealed history list. Each item keeps its own normalized
 * feature set in `items` for auditability, while `features` is the deduplicated union used for scoring. Empty history
 * is valid and produces empty path/module sets with an `unknown` change kind, matching single-input extraction.
 */
export function extractObjectiveAnchorHistory(items: readonly ObjectiveAnchorHistoryItem[]): ObjectiveAnchorHistoryExtraction {
  const itemAudits = items.map<ObjectiveAnchorHistoryItemAudit>((item, index) => ({
    id: auditItemId(item, index),
    source: auditItemSource(item),
    features: extractObjectiveAnchorFeatures(item),
  }));
  const features = itemAudits.length > 0 ? combineFeatures(itemAudits.map((item) => item.features)) : extractObjectiveAnchorFeatures({});
  return { features, items: itemAudits };
}

/**
 * Score replayed structural features against revealed history. Path and module dimensions use Dice overlap so a
 * partial module match gets visible credit without pretending it is exact. Change-kind overlap is the same metric
 * over inferred/caller-supplied kinds. The revealed side may have zero overlapping modules; that is a valid low
 * score, never an error, and the misses section explains what diverged.
 */
export function scoreObjectiveAnchor(input: {
  replayed: ObjectiveAnchorInput | ObjectiveAnchorFeatures;
  revealed: ObjectiveAnchorInput | ObjectiveAnchorFeatures;
  weights?: ObjectiveAnchorWeights | undefined;
}): ObjectiveAnchorScore {
  const replayed = isFeatures(input.replayed) ? input.replayed : extractObjectiveAnchorFeatures(input.replayed);
  const revealed = isFeatures(input.revealed) ? input.revealed : extractObjectiveAnchorFeatures(input.revealed);
  const weights = normalizeWeights(input.weights);
  const dimensions: ObjectiveAnchorDimensionScores = {
    paths: roundScore(diceOverlap(replayed.paths, revealed.paths)),
    modules: roundScore(diceOverlap(replayed.modules, revealed.modules)),
    changeKinds: roundScore(diceOverlap(replayed.changeKinds, revealed.changeKinds)),
  };
  const score = roundScore(
    dimensions.paths * weights.paths + dimensions.modules * weights.modules + dimensions.changeKinds * weights.changeKinds,
  );

  return {
    score,
    dimensions,
    audit: {
      replayed,
      revealed,
      weights,
      dimensions,
      intersections: {
        paths: intersectStrings(replayed.paths, revealed.paths),
        modules: intersectStrings(replayed.modules, revealed.modules),
        changeKinds: intersectKinds(replayed.changeKinds, revealed.changeKinds),
      },
      misses: {
        replayedOnlyPaths: differenceStrings(replayed.paths, revealed.paths),
        revealedOnlyPaths: differenceStrings(revealed.paths, replayed.paths),
        replayedOnlyModules: differenceStrings(replayed.modules, revealed.modules),
        revealedOnlyModules: differenceStrings(revealed.modules, replayed.modules),
        replayedOnlyChangeKinds: differenceKinds(replayed.changeKinds, revealed.changeKinds),
        revealedOnlyChangeKinds: differenceKinds(revealed.changeKinds, replayed.changeKinds),
      },
    },
  };
}

/**
 * Score arrays of replayed and revealed history records, preserving the per-record extraction evidence alongside the
 * normal score/audit payload. This is the ergonomic entrypoint for replay harnesses that compare a generated plan/PR
 * bundle with multiple revealed commits or merged PRs after the snapshot timestamp.
 */
export function scoreObjectiveAnchorHistory(input: {
  replayed: readonly ObjectiveAnchorHistoryItem[];
  revealed: readonly ObjectiveAnchorHistoryItem[];
  weights?: ObjectiveAnchorWeights | undefined;
}): ObjectiveAnchorHistoryScore {
  const replayed = extractObjectiveAnchorHistory(input.replayed);
  const revealed = extractObjectiveAnchorHistory(input.revealed);
  const score = scoreObjectiveAnchor({
    replayed: replayed.features,
    revealed: revealed.features,
    weights: input.weights,
  });
  return {
    ...score,
    history: { replayed, revealed },
  };
}

/**
 * Render the score audit as deterministic Markdown for local replay artifacts. The renderer escapes Markdown control
 * characters and collapses newlines in untrusted ids/paths so a caller can persist the output next to a replay run
 * without letting a path or caller-supplied id reshape the report.
 */
export function renderObjectiveAnchorAuditMarkdown(result: ObjectiveAnchorScore | ObjectiveAnchorHistoryScore): string {
  const lines = [
    "# Objective-Anchor Score",
    "",
    `Score: ${result.score.toFixed(6)}`,
    "",
    "## Dimensions",
    "",
    `- paths: ${result.dimensions.paths.toFixed(6)}`,
    `- modules: ${result.dimensions.modules.toFixed(6)}`,
    `- changeKinds: ${result.dimensions.changeKinds.toFixed(6)}`,
    "",
    "## Weights",
    "",
    `- paths: ${result.audit.weights.paths.toFixed(6)}`,
    `- modules: ${result.audit.weights.modules.toFixed(6)}`,
    `- changeKinds: ${result.audit.weights.changeKinds.toFixed(6)}`,
    "",
    "## Replayed Features",
    "",
    markdownFeatureBlock(result.audit.replayed),
    "",
    "## Revealed Features",
    "",
    markdownFeatureBlock(result.audit.revealed),
    "",
    "## Intersections",
    "",
    "Paths:",
    markdownList(result.audit.intersections.paths),
    "",
    "Modules:",
    markdownList(result.audit.intersections.modules),
    "",
    "Change kinds:",
    markdownKindList(result.audit.intersections.changeKinds),
    "",
    "## Misses",
    "",
    "Replayed-only paths:",
    markdownList(result.audit.misses.replayedOnlyPaths),
    "",
    "Revealed-only paths:",
    markdownList(result.audit.misses.revealedOnlyPaths),
    "",
    "Replayed-only modules:",
    markdownList(result.audit.misses.replayedOnlyModules),
    "",
    "Revealed-only modules:",
    markdownList(result.audit.misses.revealedOnlyModules),
    "",
    "Replayed-only change kinds:",
    markdownKindList(result.audit.misses.replayedOnlyChangeKinds),
    "",
    "Revealed-only change kinds:",
    markdownKindList(result.audit.misses.revealedOnlyChangeKinds),
  ];

  if ("history" in result) {
    lines.push(
      "",
      "## Replayed History Items",
      "",
      markdownHistoryBlock(result.history.replayed),
      "",
      "## Revealed History Items",
      "",
      markdownHistoryBlock(result.history.revealed),
    );
  }

  return `${lines.join("\n")}\n`;
}

function isFeatures(value: ObjectiveAnchorInput | ObjectiveAnchorFeatures): value is ObjectiveAnchorFeatures {
  return (
    Array.isArray((value as ObjectiveAnchorFeatures).paths) &&
    Array.isArray((value as ObjectiveAnchorFeatures).modules) &&
    Array.isArray((value as ObjectiveAnchorFeatures).changeKinds)
  );
}
