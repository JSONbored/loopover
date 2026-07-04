// Repo-profile extraction (#2999, part of the repo-doc generation roadmap #2993). Turns a repo's existing RAG
// index (src/review/rag.ts, src/review/rag-index.ts) and existing signal outputs (settings resolver,
// src/signals/focus-manifest-loader.ts) into a single, structured, versioned profile object: architecture/module
// map, naming/style conventions, test/build commands, and contribution-workflow facts.
//
// SHARED PRIMITIVE, NOT BESPOKE: this module has no dependency on generation or PR-writing (those are #3000/#3001
// downstream). It is meant to be the ONE place "what does this repo actually look like" is derived from RAG +
// signals, so the CLAUDE.md/AGENT.md generator, the review-quality-culture-profile work, and the Autonomous Miner
// System's merge-bar inference can all call `extractRepoProfile` instead of growing three divergent copies.
//
// NO SECOND INDEXING PIPELINE: extraction reads the repo_chunks store RAG ingestion already populates
// (listStoredChunkPaths / a direct path lookup) -- it never embeds, queries the vector index, or calls AI. This
// keeps the module fully deterministic and fixture-testable, and matches the issue's own "deterministic signals"
// framing: architecture/conventions/commands are read directly off indexed file paths and content, not modeled.
//
// FAIL CLOSED ON INSUFFICIENT DATA: a repo with no RAG index configured/populated returns the explicit
// `{ present: false, reason }` branch, never a partially-filled guess -- downstream generation (#3000) must treat
// that as "skip, don't generate a low-quality file" per the epic's design principles.
import { createReviewAdapters } from "./adapters";
import { listStoredChunkPaths } from "./rag-index";
import { countRepoChunks } from "./rag";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { nowIso } from "../utils/json";

/** Bumped whenever the profile SHAPE changes (not on every content tweak) -- at least three separate features
 *  consume this profile and must be able to evolve independently of each other and of this extractor. */
export const REPO_PROFILE_SCHEMA_VERSION = 1;

export type RepoProfileArchitecture = {
  /** Total distinct indexed (code/doc) file paths RAG has retained for this repo. */
  indexedFileCount: number;
  /** Top-level directories among the indexed paths, sorted by file count descending then name ascending. A
   *  file with no directory component (repo-root) is grouped under the sentinel `"."`. */
  topLevelDirectories: Array<{ path: string; fileCount: number }>;
};

export type RepoProfileTestFileConvention = "dot-test-suffix" | "dot-spec-suffix" | "tests-directory" | "none-detected";
export type RepoProfileFileNamingStyle = "kebab-case" | "camelCase" | "snake_case" | "PascalCase" | "mixed" | "unknown";

export type RepoProfileConventions = {
  fileNamingStyle: RepoProfileFileNamingStyle;
  testFileConvention: RepoProfileTestFileConvention;
};

export type RepoProfilePackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type RepoProfileCommands = {
  /** From `package.json`'s own `packageManager` corepack field when present; lockfiles are NOT indexed by RAG
   *  (rag.ts's SKIP_FILE_RE deliberately excludes them), so this is opportunistic, not guessed from a lockfile. */
  packageManager: RepoProfilePackageManager | null;
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
};

export type RepoProfileContributionWorkflow = {
  /** Whether the review gate publishes a check at all (settings.gateCheckMode / checkRunMode), reusing the
   *  EXISTING settings resolver rather than re-deriving gate presence from raw repo files. */
  gatePublishesCheck: boolean;
  linkedIssuePolicy: "required" | "preferred" | "optional";
  requireLinkedIssue: boolean;
  /** Indexed `.github/workflows/*.yml`/`*.yaml` paths -- describes CI structure without hard-coding assumptions
   *  about what workflows exist. Empty when the repo has no indexed workflow files (which may just mean RAG's
   *  code-only filter or a small chunk budget hasn't reached them yet, not that none exist). */
  ciWorkflowFiles: string[];
};

export type RepoProfile =
  | {
      version: typeof REPO_PROFILE_SCHEMA_VERSION;
      present: false;
      repoFullName: string;
      generatedAt: string;
      reason: string;
    }
  | {
      version: typeof REPO_PROFILE_SCHEMA_VERSION;
      present: true;
      repoFullName: string;
      generatedAt: string;
      architecture: RepoProfileArchitecture;
      conventions: RepoProfileConventions;
      commands: RepoProfileCommands;
      contributionWorkflow: RepoProfileContributionWorkflow;
    };

/** Split `owner/name` into the (project, repo) pair RAG namespaces on -- mirrors the identical small helper
 *  already duplicated between queue/processors.ts's splitRepoForRag and review/rag-wire.ts's private splitRepo;
 *  a third trivial local copy here matches that existing precedent rather than introducing a new cross-layer
 *  import (review modules do not currently import from queue/processors.ts). */
function splitRepoFullName(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? ["", repoFullName] : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

function insufficientData(repoFullName: string, generatedAt: string, reason: string): RepoProfile {
  return { version: REPO_PROFILE_SCHEMA_VERSION, present: false, repoFullName, generatedAt, reason };
}

/** Read a file's full text back out of the chunk store by path (concatenating multi-chunk files in chunk_index
 *  order). Fail-safe: null on any storage error or when the path isn't indexed. */
async function readIndexedFileText(
  infra: ReturnType<typeof createReviewAdapters>,
  project: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const rows = await infra.storage
      .prepare("SELECT chunk_index, text FROM repo_chunks WHERE project=? AND repo=? AND path=? ORDER BY chunk_index")
      .bind(project, repo, path)
      .all<{ chunk_index: number; text: string }>();
    const results = rows.results ?? [];
    if (results.length === 0) return null;
    return results.map((row) => row.text).join("");
  } catch {
    return null;
  }
}

const TOP_LEVEL_DIR_SENTINEL = ".";

function deriveArchitecture(paths: string[]): RepoProfileArchitecture {
  const byTopLevelDir = new Map<string, number>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    const dir = slash === -1 ? TOP_LEVEL_DIR_SENTINEL : path.slice(0, slash);
    byTopLevelDir.set(dir, (byTopLevelDir.get(dir) ?? 0) + 1);
  }
  const topLevelDirectories = [...byTopLevelDir.entries()]
    .map(([dirPath, fileCount]) => ({ path: dirPath, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));
  return { indexedFileCount: paths.length, topLevelDirectories };
}

/** Casing style of a single basename (extension stripped). Null for a basename with no casing signal at all
 *  (e.g. a single lowercase word like "index" or "types" -- it trivially matches every style, so it must not
 *  count as a vote for any of them). */
function basenameCasingStyle(basename: string): RepoProfileFileNamingStyle | null {
  if (basename.includes("-") && !basename.includes("_")) return "kebab-case";
  if (basename.includes("_") && !basename.includes("-")) return "snake_case";
  if (/^[A-Z]/.test(basename) && /[a-z]/.test(basename) && /[A-Z].*[A-Z]|[A-Z]/.test(basename.slice(1))) return "PascalCase";
  if (/^[a-z]/.test(basename) && /[A-Z]/.test(basename)) return "camelCase";
  return null;
}

function fileBasenameWithoutExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.indexOf(".");
  return dot <= 0 ? file : file.slice(0, dot);
}

const TEST_FILE_CONVENTION_PATTERNS: ReadonlyArray<{ convention: RepoProfileTestFileConvention; test: (path: string) => boolean }> = [
  { convention: "dot-test-suffix", test: (path) => /\.test\.[a-z0-9]+$/i.test(path) },
  { convention: "dot-spec-suffix", test: (path) => /\.spec\.[a-z0-9]+$/i.test(path) },
  { convention: "tests-directory", test: (path) => /(^|\/)(__tests__|tests?)\//i.test(path) },
];

function deriveConventions(paths: string[]): RepoProfileConventions {
  const styleCounts = new Map<RepoProfileFileNamingStyle, number>();
  for (const path of paths) {
    const style = basenameCasingStyle(fileBasenameWithoutExtension(path));
    if (style) styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
  }
  const rankedStyles = [...styleCounts.entries()].sort((a, b) => b[1] - a[1]);
  let fileNamingStyle: RepoProfileFileNamingStyle = "unknown";
  if (rankedStyles.length > 0) {
    const [topStyle, topCount] = rankedStyles[0]!;
    const runnerUpCount = rankedStyles[1]?.[1] ?? 0;
    // A clear majority (not just a plurality edged out by noise) is required to call it a single style; anything
    // closer than that is genuinely mixed, and reporting a false single style would mislead a generated CLAUDE.md.
    fileNamingStyle = topCount >= runnerUpCount * 2 ? topStyle : "mixed";
  }
  const conventionCounts = new Map<RepoProfileTestFileConvention, number>();
  for (const path of paths) {
    for (const { convention, test } of TEST_FILE_CONVENTION_PATTERNS) {
      if (test(path)) conventionCounts.set(convention, (conventionCounts.get(convention) ?? 0) + 1);
    }
  }
  const rankedConventions = [...conventionCounts.entries()].sort((a, b) => b[1] - a[1]);
  const testFileConvention: RepoProfileTestFileConvention = rankedConventions[0]?.[0] ?? "none-detected";
  return { fileNamingStyle, testFileConvention };
}

const COMMAND_CATEGORY_KEYWORDS: ReadonlyArray<{ category: keyof Pick<RepoProfileCommands, "buildCommands" | "testCommands" | "lintCommands">; keywords: RegExp }> = [
  { category: "testCommands", keywords: /test/i },
  { category: "lintCommands", keywords: /lint|format|typecheck|type-check/i },
  { category: "buildCommands", keywords: /build|compile|bundle/i },
];

/** Best-effort `package.json` `scripts`/`packageManager` parse. Malformed JSON or a non-object `scripts` value
 *  degrades to empty commands rather than throwing -- a broken package.json must not break profile extraction. */
function deriveCommandsFromPackageJson(packageJsonText: string | null): RepoProfileCommands {
  const empty: RepoProfileCommands = { packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] };
  if (!packageJsonText) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const record = parsed as Record<string, unknown>;
  const packageManagerField = typeof record.packageManager === "string" ? record.packageManager : null;
  const packageManagerMatch = packageManagerField ? /^(npm|yarn|pnpm|bun)@/.exec(packageManagerField) : null;
  const packageManager = (packageManagerMatch?.[1] as RepoProfilePackageManager | undefined) ?? null;
  const scripts = record.scripts && typeof record.scripts === "object" ? (record.scripts as Record<string, unknown>) : {};
  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  const lintCommands: string[] = [];
  const byCategory = { buildCommands, testCommands, lintCommands };
  for (const scriptName of Object.keys(scripts).sort()) {
    if (typeof scripts[scriptName] !== "string") continue;
    // First matching category wins (ordered test > lint > build) so a name like "test:lint" is not double-counted.
    const category = COMMAND_CATEGORY_KEYWORDS.find((entry) => entry.keywords.test(scriptName))?.category;
    if (category) byCategory[category].push(scriptName);
  }
  return { packageManager, buildCommands, testCommands, lintCommands };
}

function deriveCiWorkflowFiles(paths: string[]): string[] {
  return paths.filter((path) => /^\.github\/workflows\/.+\.ya?ml$/i.test(path)).sort();
}

export type ExtractRepoProfileOptions = {
  /** Override the generated-at timestamp (tests only; defaults to nowIso()). */
  now?: string;
};

/**
 * Extract a structured, versioned repo profile from a repo's existing RAG index and existing settings/manifest
 * signals. Returns the explicit `present: false` branch (never a partial guess) when the repo has no RAG index
 * populated yet.
 */
export async function extractRepoProfile(env: Env, repoFullName: string, options: ExtractRepoProfileOptions = {}): Promise<RepoProfile> {
  const generatedAt = options.now ?? nowIso();
  const [project, repo] = splitRepoFullName(repoFullName);
  const infra = createReviewAdapters(env);
  const chunkCount = await countRepoChunks(infra.storage, project, repo);
  if (chunkCount === 0) {
    return insufficientData(repoFullName, generatedAt, "no RAG index configured or populated for this repo yet");
  }
  const [paths, settings, manifest] = await Promise.all([
    listStoredChunkPaths(infra, project, repo),
    resolveRepositorySettings(env, repoFullName),
    loadRepoFocusManifest(env, repoFullName),
  ]);
  if (paths.length === 0) {
    // countRepoChunks() > 0 but listStoredChunkPaths() came back empty means the path-listing query itself
    // failed (it fails open to [] -- see its own doc comment) -- treat that the same as insufficient data
    // rather than emitting a profile with a hard-coded-zero architecture section.
    return insufficientData(repoFullName, generatedAt, "repo chunk store is unavailable (path listing failed)");
  }
  const packageJsonText = await readIndexedFileText(infra, project, repo, "package.json");
  return {
    version: REPO_PROFILE_SCHEMA_VERSION,
    present: true,
    repoFullName,
    generatedAt,
    architecture: deriveArchitecture(paths),
    conventions: deriveConventions(paths),
    commands: deriveCommandsFromPackageJson(packageJsonText),
    contributionWorkflow: {
      gatePublishesCheck: settings.gateCheckMode === "enabled" || settings.checkRunMode === "enabled",
      linkedIssuePolicy: manifest.linkedIssuePolicy,
      requireLinkedIssue: settings.requireLinkedIssue,
      ciWorkflowFiles: deriveCiWorkflowFiles(paths),
    },
  };
}
