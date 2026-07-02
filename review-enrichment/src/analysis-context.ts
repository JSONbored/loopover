import type {
  AnalyzerDiagnostics,
  AnalyzerMetricsDiagnostics,
  EnrichRequest,
} from "./types.js";
import {
  extractDependencyChanges,
  type DepChange,
  type ScanLimits,
} from "./analyzers/dependency-scan.js";
import {
  boundedFetchJson,
  boundedFetchStatus,
  boundedFetchText,
  externalFetchCacheKey,
  safeEndpointCategory,
  type BoundedFetchOptions,
  type BoundedFetchResult,
} from "./external-fetch.js";
import { isWorkflowPath } from "./workflow-path.js";
import { isSupportedLockfile } from "./lockfile-path.js";

type ChangedFile = NonNullable<EnrichRequest["files"]>[number];

const MAX_CONTEXT_PATCH_BYTES = 1_000_000;
const MAX_CONTEXT_ADDED_LINES = 5_000;
const MAX_CONTEXT_PATCH_HUNKS = 2_000;

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface PatchHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileCategory {
  path: string;
  extension: string;
  category:
    | "dependency-manifest"
    | "lockfile"
    | "workflow"
    | "config"
    | "asset"
    | "docs"
    | "source"
    | "unknown";
}

export interface RepoIdentity {
  owner: string | null;
  repo: string | null;
  fullName: string;
  prNumber: number;
  headSha: string | null;
}

export interface AnalysisContextMetrics extends AnalyzerMetricsDiagnostics {
  externalCallsByCategory: Record<string, number>;
  skippedWorkByCategory: Record<string, number>;
  cappedWorkByCategory: Record<string, number>;
}

export interface AnalysisContext {
  repo: RepoIdentity;
  changedFiles: readonly ChangedFile[];
  changedFilePaths: readonly string[];
  addedLines: readonly AddedLine[];
  patchHunks: readonly PatchHunk[];
  hasAddedLines: boolean;
  fileCategories: readonly FileCategory[];
  dependencyManifestPaths: readonly string[];
  cache: RequestScopedCache;
  metrics: AnalysisMetrics;
  cachedExternalCall<T>(
    category: string,
    key: string,
    load: () => Promise<T>,
  ): Promise<T>;
  fetchJson<T>(
    url: string,
    options: AnalysisFetchJsonOptions,
  ): Promise<BoundedFetchResult<T>>;
  fetchText(
    url: string,
    options: AnalysisFetchJsonOptions,
  ): Promise<BoundedFetchResult<string>>;
  fetchStatus(
    url: string,
    options: AnalysisFetchJsonOptions,
  ): Promise<BoundedFetchResult<null>>;
  dependencyChanges(limits?: ScanLimits): readonly DepChange[];
  packageChanges(limits?: ScanLimits): readonly DepChange[];
  remainingMs(deadlineMs?: number): number;
  snapshotMetrics(): AnalysisContextMetrics;
}

export interface AnalysisFetchJsonOptions
  extends Omit<BoundedFetchOptions, "endpointCategory"> {
  endpointCategory: string;
  cache?: boolean;
  cacheKey?: string;
  maxCallsPerCategory?: number;
  diagnostics?: AnalyzerDiagnostics;
}

export class AnalysisMetrics {
  cacheHits = 0;
  cacheMisses = 0;
  externalCallsByCategory: Record<string, number> = {};
  skippedWorkByCategory: Record<string, number> = {};
  cappedWorkByCategory: Record<string, number> = {};

  constructor(
    private readonly startedAtMs: number,
    private readonly now: () => number,
  ) {}

  recordCacheHit(count = 1): void {
    this.cacheHits += Math.max(0, count);
  }

  recordCacheMiss(count = 1): void {
    this.cacheMisses += Math.max(0, count);
  }

  recordExternalCall(category: string, count = 1): void {
    incrementByCategory(this.externalCallsByCategory, category, count);
  }

  externalCallCount(category: string): number {
    return this.externalCallsByCategory[safeMetricCategory(category)] ?? 0;
  }

  recordSkippedWork(category: string, count = 1): void {
    incrementByCategory(this.skippedWorkByCategory, category, count);
  }

  recordCappedWork(category: string, count = 1): void {
    incrementByCategory(this.cappedWorkByCategory, category, count);
  }

  snapshot(): AnalysisContextMetrics {
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      externalCallsByCategory: { ...this.externalCallsByCategory },
      skippedWorkByCategory: { ...this.skippedWorkByCategory },
      cappedWorkByCategory: { ...this.cappedWorkByCategory },
      analysisElapsedMs: Math.max(0, Math.floor(this.now() - this.startedAtMs)),
    };
  }
}

export class RequestScopedCache {
  private readonly entries = new Map<string, Promise<unknown>>();

  constructor(private readonly metrics: AnalysisMetrics) {}

  get size(): number {
    return this.entries.size;
  }

  getOrSet<T>(
    category: string,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = requestCacheKey(category, key);
    const existing = this.entries.get(cacheKey);
    if (existing) {
      this.metrics.recordCacheHit();
      return existing as Promise<T>;
    }
    this.metrics.recordCacheMiss();
    const promise = Promise.resolve()
      .then(load)
      .catch((error) => {
        this.entries.delete(cacheKey);
        throw error;
      });
    this.entries.set(cacheKey, promise);
    return promise;
  }
}

function requestCacheKey(category: string, key: string): string {
  return JSON.stringify([safeMetricCategory(category), key]);
}

export function createAnalysisContext(
  req: EnrichRequest,
  options: { startedAtMs?: number; deadlineMs?: number; now?: () => number } = {},
): AnalysisContext {
  const now = options.now ?? Date.now;
  const startedAtMs = options.startedAtMs ?? now();
  const changedFiles = req.files ?? [];
  const metrics = new AnalysisMetrics(startedAtMs, now);
  const cache = new RequestScopedCache(metrics);
  const dependencyChangeCache = new Map<string, readonly DepChange[]>();
  let changedFilePathsCache: readonly string[] | undefined;
  let addedLinesCache: readonly AddedLine[] | undefined;
  let patchHunksCache: readonly PatchHunk[] | undefined;
  let hasAddedLinesCache: boolean | undefined;
  const fileCategories = changedFiles.map((file) => categorizeFile(file.path));
  const dependencyManifestPaths = fileCategories
    .filter((file) => file.category === "dependency-manifest")
    .map((file) => file.path);

  const context: AnalysisContext = {
    repo: parseRepoIdentity(req),
    changedFiles,
    get changedFilePaths() {
      changedFilePathsCache ??= changedFiles.map((file) => file.path);
      return changedFilePathsCache;
    },
    get addedLines() {
      addedLinesCache ??= collectAddedLines(changedFiles, { metrics });
      return addedLinesCache;
    },
    get patchHunks() {
      patchHunksCache ??= collectPatchHunks(changedFiles, { metrics });
      return patchHunksCache;
    },
    get hasAddedLines() {
      hasAddedLinesCache ??= filesHaveAddedLines(changedFiles, { metrics });
      return hasAddedLinesCache;
    },
    fileCategories,
    dependencyManifestPaths,
    cache,
    metrics,
    cachedExternalCall(category, key, load) {
      return cache.getOrSet(category, key, () => {
        metrics.recordExternalCall(category);
        return load();
      });
    },
    fetchJson<T>(url: string, options: AnalysisFetchJsonOptions) {
      return cachedBoundedFetch<T>(cache, metrics, url, options, boundedFetchJson);
    },
    fetchText(url: string, options: AnalysisFetchJsonOptions) {
      return cachedBoundedFetch(cache, metrics, url, options, boundedFetchText);
    },
    fetchStatus(url: string, options: AnalysisFetchJsonOptions) {
      return cachedBoundedFetch(cache, metrics, url, options, boundedFetchStatus);
    },
    dependencyChanges(limits: ScanLimits = {}) {
      const key = dependencyLimitKey(limits);
      const cached = dependencyChangeCache.get(key);
      if (cached) {
        metrics.recordCacheHit();
        return cached;
      }
      metrics.recordCacheMiss();
      if (
        typeof limits.maxManifestFiles === "number" &&
        dependencyManifestPaths.length > limits.maxManifestFiles
      ) {
        metrics.recordCappedWork(
          "dependency_manifest_files",
          dependencyManifestPaths.length - limits.maxManifestFiles,
        );
      }
      const extracted = extractDependencyChanges(changedFiles, limits);
      const maxDependencyQueries = limits.maxDependencyQueries;
      const changes =
        typeof maxDependencyQueries === "number"
          ? extracted.slice(0, maxDependencyQueries)
          : extracted;
      if (
        typeof maxDependencyQueries === "number" &&
        extracted.length > maxDependencyQueries
      ) {
        metrics.recordCappedWork(
          "dependency_queries",
          extracted.length - maxDependencyQueries,
        );
      }
      dependencyChangeCache.set(key, changes);
      return changes;
    },
    packageChanges(limits: ScanLimits = {}) {
      return context.dependencyChanges(limits);
    },
    remainingMs(deadlineMs = options.deadlineMs) {
      if (typeof deadlineMs !== "number") return Number.POSITIVE_INFINITY;
      return Math.max(0, deadlineMs - now());
    },
    snapshotMetrics() {
      return metrics.snapshot();
    },
  };

  return context;
}

export function collectAddedLines(
  files: readonly ChangedFile[],
  options: { metrics?: AnalysisMetrics } = {},
): AddedLine[] {
  const addedLines: AddedLine[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    let newLine = 0;
    let inHunk = false;
    for (const line of boundedPatchLines(file.patch, options.metrics, "added_lines_patch_bytes")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      // Skip the pre-hunk preamble (diff/index + the `+++ `/`--- ` file headers). INSIDE a hunk the first char
      // is the +/-/space op, so `+++x`/`+++ x` added content is collected, not mistaken for a header.
      if (!inHunk) continue;
      if (line.startsWith("+")) {
        if (addedLines.length >= MAX_CONTEXT_ADDED_LINES) {
          options.metrics?.recordCappedWork("added_lines", 1);
          return addedLines;
        }
        addedLines.push({ file: file.path, line: newLine, text: line.slice(1) });
        newLine += 1;
      } else if (!line.startsWith("-")) {
        newLine += 1;
      }
    }
  }
  return addedLines;
}

export function collectPatchHunks(
  files: readonly ChangedFile[],
  options: { metrics?: AnalysisMetrics } = {},
): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    for (const line of boundedPatchLines(file.patch, options.metrics, "patch_hunk_bytes")) {
      const hunk =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      if (hunks.length >= MAX_CONTEXT_PATCH_HUNKS) {
        options.metrics?.recordCappedWork("patch_hunks", 1);
        return hunks;
      }
      hunks.push({
        file: file.path,
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] ? Number(hunk[2]) : 1,
        newStart: Number(hunk[3]),
        newLines: hunk[4] ? Number(hunk[4]) : 1,
      });
    }
  }
  return hunks;
}

export function filesHaveAddedLines(
  files: readonly ChangedFile[],
  options: { metrics?: AnalysisMetrics } = {},
): boolean {
  for (const file of files) {
    if (!file.patch) continue;
    let inHunk = false;
    for (const line of boundedPatchLines(
      file.patch,
      options.metrics,
      "has_added_lines_patch_bytes",
    )) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      // Inside a hunk every added line starts with `+` (including `+++x`/`+++ x` content); the `+++ `/`--- `
      // headers only appear in the pre-hunk preamble.
      if (inHunk && line.startsWith("+")) return true;
    }
    if (file.patch.length > MAX_CONTEXT_PATCH_BYTES) return true;
  }
  return false;
}

function* boundedPatchLines(
  patch: string,
  metrics: AnalysisMetrics | undefined,
  cappedCategory: string,
): Generator<string> {
  const maxLength = Math.min(patch.length, MAX_CONTEXT_PATCH_BYTES);
  let lineStart = 0;
  while (lineStart <= maxLength) {
    const newline = patch.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline > maxLength ? maxLength : newline;
    yield patch.slice(lineStart, lineEnd);
    if (newline === -1 || newline >= maxLength) break;
    lineStart = newline + 1;
  }
  if (patch.length > MAX_CONTEXT_PATCH_BYTES) {
    metrics?.recordCappedWork(cappedCategory, patch.length - MAX_CONTEXT_PATCH_BYTES);
  }
}

function parseRepoIdentity(req: EnrichRequest): RepoIdentity {
  const parts = req.repoFullName.split("/");
  const owner = parts.length === 2 && parts[0] ? parts[0] : null;
  const repo = parts.length === 2 && parts[1] ? parts[1] : null;
  return {
    owner,
    repo,
    fullName: req.repoFullName,
    prNumber: req.prNumber,
    headSha: req.headSha ?? null,
  };
}

function categorizeFile(path: string): FileCategory {
  const basename = path.split("/").pop() ?? path;
  const extension = extensionOf(basename);
  if (["package.json", "requirements.txt", "go.mod"].includes(basename)) {
    return { path, extension, category: "dependency-manifest" };
  }
  if (isSupportedLockfile(path)) {
    return { path, extension, category: "lockfile" };
  }
  if (isWorkflowPath(path)) {
    return { path, extension, category: "workflow" };
  }
  if (
    /^Dockerfile(?:\..*)?$/.test(basename) ||
    [".env", ".hcl", ".ini", ".json", ".tf", ".toml", ".yaml", ".yml"].includes(extension)
  ) {
    return { path, extension, category: "config" };
  }
  if ([".md", ".mdx", ".rst", ".txt"].includes(extension)) {
    return { path, extension, category: "docs" };
  }
  if (
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".zip", ".gz"].includes(
      extension,
    )
  ) {
    return { path, extension, category: "asset" };
  }
  if (extension) return { path, extension, category: "source" };
  return { path, extension, category: "unknown" };
}

function extensionOf(basename: string): string {
  const index = basename.lastIndexOf(".");
  if (index <= 0) return "";
  return basename.slice(index).toLowerCase();
}

function dependencyLimitKey(limits: ScanLimits): string {
  return [
    limits.maxManifestFiles ?? "",
    limits.maxPatchLinesPerFile ?? "",
    limits.maxDependencyQueries ?? "",
  ].join(":");
}

function incrementByCategory(
  target: Record<string, number>,
  category: string,
  count: number,
): void {
  const safeCategory = safeMetricCategory(category);
  target[safeCategory] = (target[safeCategory] ?? 0) + Math.max(0, count);
}

function safeMetricCategory(category: string): string {
  const safe = category.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
  return safe || "unknown";
}

function markExternalCap(
  diagnostics: AnalyzerDiagnostics,
  endpointCategory: string,
): void {
  diagnostics.partialStatus = "partial";
  diagnostics.partialReason ??= `${endpointCategory}_call_cap`;
  diagnostics.captureDegradation = true;
  diagnostics.endpointCategory = endpointCategory;
  diagnostics.externalFailureReason = "call_cap";
  diagnostics.subcall = endpointCategory;
  diagnostics.capped = true;
  if (endpointCategory.startsWith("github-")) {
    diagnostics.githubEndpointCategory = endpointCategory;
  }
}

function cachedBoundedFetch<T>(
  cache: RequestScopedCache,
  metrics: AnalysisMetrics,
  url: string,
  options: AnalysisFetchJsonOptions,
  loadBounded: (
    url: string,
    options: BoundedFetchOptions,
  ) => Promise<BoundedFetchResult<T>>,
): Promise<BoundedFetchResult<T>> {
  const category = safeEndpointCategory(options.endpointCategory);
  const cacheKey = options.cacheKey ?? externalFetchCacheKey(url, options);
  const load = () => {
    if (
      typeof options.maxCallsPerCategory === "number" &&
      metrics.externalCallCount(category) >= options.maxCallsPerCategory
    ) {
      metrics.recordCappedWork(`${category}_calls`);
      options.diagnostics && markExternalCap(options.diagnostics, category);
      return Promise.resolve({
        ok: false as const,
        reason: "call_cap" as const,
        bytes: null,
        elapsedMs: 0,
        endpointCategory: category,
        capped: true,
      });
    }
    metrics.recordExternalCall(category);
    return loadBounded(url, { ...options, endpointCategory: category });
  };
  return options.cache === false ? load() : cache.getOrSet(category, cacheKey, load);
}
