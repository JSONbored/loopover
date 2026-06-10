import { execFileSync } from "node:child_process";

export type RaycastBranchAnalysisFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export type RaycastGitRunner = (cwd: string, args: string[]) => string[];

export type RaycastChangedFileMetadata = {
  path: string;
  previousPath?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown" | undefined;
  binary?: boolean | undefined;
};

export type RaycastLocalRepoMetadata = {
  login: string;
  repoFullName: string;
  baseRef: string;
  headRef: string;
  branchName: string;
  baseSha?: string | undefined;
  headSha?: string | undefined;
  mergeBaseSha?: string | undefined;
  remoteTrackingSha?: string | undefined;
  commitMessages: string[];
  changedFiles: RaycastChangedFileMetadata[];
  linkedIssues: number[];
  testFileCount: number;
  validationHints: string[];
  warnings: string[];
  sourceUpload: {
    enabled: false;
    mode: "metadata_only";
  };
};

export type RaycastBranchAnalysisResult =
  | {
      status: "ready";
      metadata: RaycastLocalRepoMetadata;
      analysis: unknown;
    }
  | {
      status: "api_error";
      metadata: RaycastLocalRepoMetadata;
      error: string;
      rerunGuidance: string;
    };

export function collectRaycastLocalRepoMetadata(input: {
  cwd: string;
  login: string;
  repoFullName?: string | undefined;
  baseRef?: string | undefined;
  branchName?: string | undefined;
  body?: string | undefined;
  linkedIssues?: number[] | undefined;
  validationHints?: string[] | undefined;
  sourceUploadMode?: "metadata_only" | "source_upload" | undefined;
  git?: RaycastGitRunner | undefined;
}): RaycastLocalRepoMetadata {
  if (input.sourceUploadMode === "source_upload") {
    throw new Error("Raycast branch analysis supports metadata-only mode; source upload mode is rejected.");
  }
  const git = input.git ?? gitLines;
  const rawBaseRef = input.baseRef ?? git(input.cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])[0]?.replace(/^origin\//, "") ?? "main";
  const baseRef = validateSafeBaseRef(rawBaseRef);
  const remoteUrl = git(input.cwd, ["config", "--get", "remote.origin.url"])[0] ?? "";
  const repoFullName = input.repoFullName ?? parseGitHubRemote(remoteUrl);
  if (!repoFullName) throw new Error("Could not infer repoFullName from the git remote; pass repoFullName explicitly.");
  const branchName = input.branchName ?? git(input.cwd, ["branch", "--show-current"])[0] ?? "local-branch";
  const headRef = git(input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])[0] ?? branchName;
  const baseSha = git(input.cwd, ["rev-parse", "--verify", baseRef])[0];
  const headSha = git(input.cwd, ["rev-parse", "--verify", "HEAD"])[0];
  const mergeBaseSha = git(input.cwd, ["merge-base", baseRef, "HEAD"])[0];
  const remoteTrackingSha = collectRemoteTrackingSha(input.cwd, baseRef, git);
  const changedFiles = collectChangedFiles(input.cwd, baseRef, git);
  const commitMessages = git(input.cwd, ["log", "--format=%s%n%b", `${baseRef}..HEAD`]).slice(0, 30);
  const linkedIssues = uniquePositiveInts([
    ...(input.linkedIssues ?? []),
    ...extractLinkedIssues([branchName, input.body, ...commitMessages].filter(Boolean).join("\n")),
  ]);
  const testFileCount = changedFiles.filter((file) => isTestFile(file.path)).length;
  const validationHints = [
    ...buildValidationHints(changedFiles, testFileCount),
    ...(input.validationHints ?? []),
  ];
  const warnings = buildMetadataWarnings({ baseRef, baseSha, mergeBaseSha, remoteTrackingSha });
  return stripUndefined({
    login: input.login,
    repoFullName,
    baseRef,
    headRef,
    branchName,
    baseSha,
    headSha,
    mergeBaseSha,
    remoteTrackingSha,
    commitMessages,
    changedFiles,
    linkedIssues,
    testFileCount,
    validationHints,
    warnings,
    sourceUpload: { enabled: false, mode: "metadata_only" },
  });
}

export async function runRaycastBranchAnalysisCommand(input: {
  apiOrigin: string;
  sessionToken: string;
  cwd: string;
  login: string;
  repoFullName?: string | undefined;
  baseRef?: string | undefined;
  body?: string | undefined;
  fetchImpl: RaycastBranchAnalysisFetch;
  git?: RaycastGitRunner | undefined;
}): Promise<RaycastBranchAnalysisResult> {
  const metadata = collectRaycastLocalRepoMetadata(input);
  const payload = branchAnalysisPayload(metadata);
  try {
    const analysis = await postJson(input, "/v1/local/branch-analysis", payload);
    return { status: "ready", metadata, analysis };
  } catch (error) {
    return {
      status: "api_error",
      metadata,
      error: error instanceof Error ? error.message : String(error),
      rerunGuidance: "Retry when the Gittensory API is reachable; the local metadata payload was not expanded with source contents.",
    };
  }
}

export function branchAnalysisPayload(metadata: RaycastLocalRepoMetadata): Record<string, unknown> {
  return stripUndefined({
    login: metadata.login,
    repoFullName: metadata.repoFullName,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    branchName: metadata.branchName,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    mergeBaseSha: metadata.mergeBaseSha,
    remoteTrackingSha: metadata.remoteTrackingSha,
    commitMessages: metadata.commitMessages,
    changedFiles: metadata.changedFiles,
    linkedIssues: metadata.linkedIssues,
    ciStatusHints: metadata.validationHints,
    localScorer: {
      mode: "metadata_only",
      warnings: metadata.warnings,
    },
  });
}

export function parseGitHubRemote(remoteUrl: string): string | undefined {
  const trimmed = String(remoteUrl ?? "").trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  }
  return undefined;
}

async function postJson(
  input: { apiOrigin: string; sessionToken: string; fetchImpl: RaycastBranchAnalysisFetch },
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(path, input.apiOrigin);
  const response = await input.fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorFromPayload(payload, response));
  return payload;
}

function validateSafeBaseRef(baseRef: string): string {
  if (!baseRef || baseRef.startsWith("-")) {
    throw new Error("Unsafe git baseRef; pass a branch or ref name that does not begin with '-'.");
  }
  return baseRef;
}

function collectChangedFiles(cwd: string, baseRef: string, git: RaycastGitRunner): RaycastChangedFileMetadata[] {
  const numstat = new Map(parseNumstat(cwd, baseRef, git).map((entry) => [entry.path, entry]));
  return git(cwd, ["diff", "--name-status", "-M", baseRef, "--"]).map((row) => {
    const fields = row.split(/\t/);
    const code = fields[0] ?? "";
    const pathPair = code.startsWith("R") || code.startsWith("C");
    const path = pathPair ? fields[2] ?? fields[1] ?? "" : fields[1] ?? "";
    const stats = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false };
    return stripUndefined({
      path,
      previousPath: pathPair ? fields[1] : undefined,
      additions: stats.additions,
      deletions: stats.deletions,
      status: statusFromCode(code),
      binary: stats.binary,
    });
  });
}

function parseNumstat(cwd: string, baseRef: string, git: RaycastGitRunner): Array<{ path: string; additions: number; deletions: number; binary: boolean }> {
  return git(cwd, ["diff", "--numstat", "-M", baseRef, "--"]).map((row) => {
    const fields = row.split(/\t/);
    const additions = fields[0] === "-" ? 0 : Number(fields[0] ?? 0);
    const deletions = fields[1] === "-" ? 0 : Number(fields[1] ?? 0);
    return {
      path: normalizeNumstatPath(fields.slice(2).join("\t")),
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: fields[0] === "-" || fields[1] === "-",
    };
  });
}

function collectRemoteTrackingSha(cwd: string, baseRef: string, git: RaycastGitRunner): string | undefined {
  const trackingRef = baseRef.includes("/") ? baseRef : `origin/${baseRef}`;
  return git(cwd, ["rev-parse", "--verify", trackingRef])[0];
}

function buildMetadataWarnings(args: {
  baseRef: string;
  baseSha?: string | undefined;
  mergeBaseSha?: string | undefined;
  remoteTrackingSha?: string | undefined;
}): string[] {
  return [
    ...(args.remoteTrackingSha && args.mergeBaseSha && args.mergeBaseSha !== args.remoteTrackingSha
      ? [`Base ${args.baseRef} appears stale relative to remote tracking SHA ${shortSha(args.remoteTrackingSha)}.`]
      : []),
    ...(args.remoteTrackingSha && args.baseSha && args.baseSha !== args.remoteTrackingSha
      ? [`Local base ref ${args.baseRef} differs from remote tracking SHA ${shortSha(args.remoteTrackingSha)}.`]
      : []),
  ];
}

function buildValidationHints(files: RaycastChangedFileMetadata[], testFileCount: number): string[] {
  const paths = files.map((file) => file.path);
  return [
    ...(testFileCount > 0 ? [`${testFileCount} changed test file(s) detected.`] : ["No changed test files detected; include focused validation before requesting review."]),
    ...(paths.some((path) => /^\.github\/workflows\//i.test(path)) ? ["Workflow files changed; required-check behavior may change."] : []),
    ...(paths.some((path) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pyproject\.toml|go\.mod|Cargo\.toml|Makefile|Dockerfile)$/i.test(path))
      ? ["Build or dependency manifests changed; rerun the repository's standard validation gate."]
      : []),
    ...(files.some((file) => file.binary) ? ["Binary file metadata detected; review binary diffs locally before relying on metadata-only analysis."] : []),
  ];
}

function gitLines(cwd: string, args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractLinkedIssues(text: string): number[] {
  return [...text.matchAll(/(?:#|(?:fixes|closes|resolves)\s+#)(\d+)/gi)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0);
}

function statusFromCode(code: string): RaycastChangedFileMetadata["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  return "unknown";
}

function normalizeNumstatPath(value: string): string {
  const rename = value.match(/^(?:.*\{(.+?) => (.+?)\}.*)$/);
  if (rename?.[2]) return value.replace(/\{(.+?) => (.+?)\}/, rename[2]);
  return value;
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__)\/|(^|\/)[^/]+_test\.(go|py|rb)$|(^|\/)[^/]+_spec\.rb$|\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(path);
}

function errorFromPayload(payload: unknown, response: { status: number; statusText?: string }): string {
  const error = payload && typeof payload === "object" ? (payload as Record<string, unknown>).error : undefined;
  if (typeof error === "string") {
    return error;
  }
  return `${response.status} ${response.statusText ?? "Raycast branch analysis request failed"}`;
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function uniquePositiveInts(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
