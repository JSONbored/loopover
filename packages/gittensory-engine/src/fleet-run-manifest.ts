import { parse as parseYaml } from "yaml";

// FleetRunManifest (#4299). The top-level config a *fleet operator* authors to run the miner across many repos:
// which repos are in scope for a fleet run, and how a finite worktree/concurrency budget is split between them.
// This is the OPERATOR-side analogue of, and deliberately NOT the same file as, `.gittensory-miner.yml` (see
// miner-goal-spec.ts): that one is authored by a *target repo's maintainer* to say how their one repo wants to be
// approached. Same tolerant-parser convention (every field optional, unknown keys ignored, malformed input
// degrades to a documented default with a warning rather than throwing); opposite author and direction of intent.
// See packages/gittensory-miner/docs/fleet-run-manifest.md for the full distinction.

/** One target repo in a fleet run, with its own concurrent-worktree budget. */
export type FleetRunManifestRepo = {
  /** Canonical `owner/repo`. Compatible with opportunity-fanout's target normalization (a splittable pair). */
  repoFullName: string;
  /**
   * Max concurrent worktrees (in-flight attempts) this repo may hold at once. A positive integer (`>= 1`); a
   * non-integer is floored, a value below 1 falls back to the default. Default: 1.
   */
  maxConcurrentWorktrees: number;
};

/** Fleet run-manifest: the repos to work across and how to split the concurrency budget. See {@link DEFAULT_FLEET_RUN_MANIFEST}. */
export type FleetRunManifest = {
  /** Target repos, de-duplicated by `repoFullName` (first entry wins). Default: [] (no repos in scope). */
  repos: readonly FleetRunManifestRepo[];
  /**
   * Total concurrent worktrees across the whole fleet, regardless of per-repo budgets. A positive integer
   * (`>= 1`); floored, sub-1 falls back to the default. Default: 1.
   */
  totalConcurrentWorktrees: number;
};

/** Tolerant parser result: the normalized manifest plus warnings and whether the file expressed any non-default
 *  field. Mirrors {@link ParsedMinerGoalSpec}'s present/warnings shape. */
export type ParsedFleetRunManifest = {
  present: boolean;
  manifest: FleetRunManifest;
  warnings: string[];
};

/** Safe defaults applied when a field is absent (or the file is missing): no repos in scope, one worktree total.
 *  Deep-frozen shared singleton — clone before layering overrides. */
export const DEFAULT_FLEET_RUN_MANIFEST: FleetRunManifest = Object.freeze({
  repos: Object.freeze([]),
  totalConcurrentWorktrees: 1,
});

const MAX_FLEET_RUN_MANIFEST_BYTES = 65_536;
const MAX_MANIFEST_REPOS = 500;

function cloneDefaultFleetRunManifest(): FleetRunManifest {
  return { ...DEFAULT_FLEET_RUN_MANIFEST, repos: [...DEFAULT_FLEET_RUN_MANIFEST.repos] };
}

function emptyFleetRunManifest(warnings: string[] = []): ParsedFleetRunManifest {
  return { present: false, manifest: cloneDefaultFleetRunManifest(), warnings };
}

/** `owner/repo` with exactly one slash and non-empty halves; anything else → null. Same shape the goal-spec /
 *  portfolio-queue validators use, so a manifest repo is directly compatible with opportunity-fanout targets. */
function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return `${owner}/${repo}`;
}

function normalizePositiveInteger(value: unknown, field: string, fallback: number, warnings: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`FleetRunManifest field "${field}" must be a positive whole number; falling back to ${fallback}.`);
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized >= 1) return normalized;
  warnings.push(`FleetRunManifest field "${field}" must be >= 1 after flooring; falling back to ${fallback}.`);
  return fallback;
}

// A repo entry may be a bare `"owner/repo"` string (uses the default per-repo budget) or a `{ repoFullName,
// maxConcurrentWorktrees? }` mapping. Anything else, or an unparseable repo name, is skipped with a warning.
function normalizeRepoList(value: unknown, warnings: string[]): FleetRunManifestRepo[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`FleetRunManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: FleetRunManifestRepo[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (index >= MAX_MANIFEST_REPOS) {
      warnings.push(`FleetRunManifest field "repos" exceeded ${MAX_MANIFEST_REPOS} entries; extra entries ignored.`);
      break;
    }
    let repoFullName: string | null;
    let maxConcurrentWorktrees = DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees;
    if (typeof entry === "string") {
      repoFullName = normalizeRepoFullName(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      repoFullName = normalizeRepoFullName(record.repoFullName);
      maxConcurrentWorktrees = normalizePositiveInteger(record.maxConcurrentWorktrees, "maxConcurrentWorktrees", 1, warnings);
    } else {
      warnings.push(`FleetRunManifest "repos" skipped a non-string, non-mapping entry.`);
      continue;
    }
    if (repoFullName === null) {
      warnings.push(`FleetRunManifest "repos" skipped an entry with an invalid "owner/repo" name.`);
      continue;
    }
    if (seen.has(repoFullName)) {
      warnings.push(`FleetRunManifest "repos" skipped a duplicate entry for ${repoFullName}.`);
      continue;
    }
    seen.add(repoFullName);
    result.push({ repoFullName, maxConcurrentWorktrees });
  }
  return result;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function hasConfiguredManifestFields(manifest: FleetRunManifest): boolean {
  return manifest.repos.length > 0 || manifest.totalConcurrentWorktrees !== DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees;
}

/**
 * Tolerantly normalize an already-parsed run-manifest object into a {@link ParsedFleetRunManifest}. Never throws:
 * malformed shapes degrade to safe defaults and accumulate warnings so a fleet run can surface "your run-manifest
 * had problems" without hard-failing. Mirrors {@link parseMinerGoalSpec}.
 */
export function parseFleetRunManifest(raw: unknown): ParsedFleetRunManifest {
  if (raw === undefined || raw === null) return emptyFleetRunManifest();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyFleetRunManifest([
      "FleetRunManifest must be a mapping of fields; ignoring malformed config and falling back to safe defaults.",
    ]);
  }
  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const manifest: FleetRunManifest = {
    repos: normalizeRepoList(record.repos, warnings),
    totalConcurrentWorktrees: normalizePositiveInteger(
      record.totalConcurrentWorktrees,
      "totalConcurrentWorktrees",
      DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees,
      warnings,
    ),
  };
  if (!hasConfiguredManifestFields(manifest)) {
    warnings.push("FleetRunManifest contained no recognized non-default fields; falling back to safe defaults.");
    return { present: false, manifest: cloneDefaultFleetRunManifest(), warnings };
  }
  return { present: true, manifest, warnings };
}

/**
 * Parse raw run-manifest file content (JSON or YAML). Malformed content degrades to an absent manifest with a
 * warning rather than throwing, mirroring {@link parseMinerGoalSpecContent}.
 */
export function parseFleetRunManifestContent(content: string | null | undefined): ParsedFleetRunManifest {
  if (content === undefined || content === null || content.trim() === "") return emptyFleetRunManifest();
  if (utf8ByteLength(content) > MAX_FLEET_RUN_MANIFEST_BYTES) {
    return emptyFleetRunManifest([
      `FleetRunManifest content exceeded ${MAX_FLEET_RUN_MANIFEST_BYTES} bytes; ignoring it and falling back to safe defaults.`,
    ]);
  }
  const trimmed = content.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return emptyFleetRunManifest([
      looksLikeJson
        ? "FleetRunManifest content was not valid JSON; ignoring it and falling back to safe defaults."
        : "FleetRunManifest content was not valid YAML; ignoring it and falling back to safe defaults.",
    ]);
  }
  return parseFleetRunManifest(parsed);
}
