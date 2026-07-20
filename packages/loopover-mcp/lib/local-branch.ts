import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCodeFile, isTestPath as isTestFile } from "@loopover/engine/signals/test-evidence";
import { redactLocalPath } from "./redact-local-path.js";

export { isCodeFile, isTestFile };
export { redactLocalPath };

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

export type ChangedFile = {
  path: string;
  previousPath?: string | undefined;
  additions: number;
  deletions: number;
  status: ChangedFileStatus;
  binary: boolean;
};

export type McpRootInput = { uri?: unknown; name?: unknown };
export type WorkspaceRoot = { path: string };

export type LocalDiff = {
  title: string;
  commitMessage: string;
  changedFiles: string[];
  changedLineCount: number;
  testFiles: string[];
  codeFiles: string[];
};

export type CollectLocalBranchMetadataInput = {
  cwd?: string | null | undefined;
  workspaceRoots?: McpRootInput[] | undefined;
  baseRef?: string | undefined;
  repoFullName?: string | undefined;
  branchName?: string | undefined;
  headRef?: string | undefined;
  login?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  labels?: unknown;
  linkedIssues?: number[] | undefined;
  commitMessages?: string[] | undefined;
  validation?: unknown;
  pendingMergedPrCount?: number | undefined;
  pendingClosedPrCount?: number | undefined;
  approvedPrCount?: number | undefined;
  expectedOpenPrCountAfterMerge?: number | undefined;
  projectedCredibility?: unknown;
  scenarioNotes?: unknown;
  pendingCommitCount?: number | undefined;
  ciStatusHints?: string[] | undefined;
  branchEligibility?: unknown;
};

export type LocalBranchMetadata = {
  login?: string | undefined;
  repoFullName: string;
  baseRef: string;
  headRef: string;
  branchName: string;
  baseSha?: string | undefined;
  headSha?: string | undefined;
  mergeBaseSha?: string | undefined;
  remoteTrackingSha?: string | undefined;
  commitMessages: string[];
  changedFiles: ChangedFile[];
  validation?: unknown;
  linkedIssues: number[];
  labels?: unknown;
  title?: string | undefined;
  body?: string | undefined;
  pendingMergedPrCount?: number | undefined;
  pendingClosedPrCount?: number | undefined;
  approvedPrCount?: number | undefined;
  expectedOpenPrCountAfterMerge?: number | undefined;
  projectedCredibility?: unknown;
  scenarioNotes?: unknown;
  pendingCommitCount: number;
  ciStatusHints: string[];
  branchEligibility?: unknown;
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function parseGitRemote(remoteUrl: unknown): string | undefined {
  const trimmed = stripTrailingSlashes(String(remoteUrl ?? "").trim());
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
  }
  return undefined;
}

export function collectLocalDiff(cwd: string, baseRef: string, workspaceRoots?: McpRootInput[]): LocalDiff {
  const metadata = collectLocalBranchMetadata({ cwd, baseRef, login: "local", workspaceRoots });
  return {
    // metadata.title is provably defined here: this call always resolves branchName through the same
    // "??...??\"local-branch\"" chain collectLocalBranchMetadata itself uses (collectLocalDiff has no
    // way to override branchName to force it empty), and titleFromBranch("local-branch") is non-empty.
    title: metadata.title as string,
    commitMessage: metadata.commitMessages.join("\n\n").trim(),
    changedFiles: metadata.changedFiles.map((file) => file.path),
    // file.additions/deletions are always real numbers here (ChangedFile's own type, always populated by
    // collectChangedFiles) -- collectLocalDiff has no way to inject a differently-shaped changedFiles.
    changedLineCount: metadata.changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    testFiles: metadata.changedFiles.map((file) => file.path).filter(isTestFile),
    codeFiles: metadata.changedFiles.map((file) => file.path).filter(isCodeFile),
  };
}

export function collectLocalBranchMetadata(input: CollectLocalBranchMetadataInput): LocalBranchMetadata {
  assertSourceUploadDisabled();
  const workspace = resolveWorkspaceCwd(input);
  const cwd = workspace.cwd;
  const baseRef = input.baseRef ?? defaultBaseRef(cwd);
  const remoteUrl = gitLines(cwd, ["config", "--get", "remote.origin.url"])[0] ?? "";
  const repoFullName = input.repoFullName ?? parseGitRemote(remoteUrl);
  if (!repoFullName) throw new Error("Could not infer repoFullName from git remote; pass --repo owner/repo.");
  const branchName = input.branchName ?? gitLines(cwd, ["branch", "--show-current"])[0] ?? "local-branch";
  const headRef = input.headRef ?? gitLines(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])[0] ?? branchName;
  const baseSha = gitLines(cwd, ["rev-parse", "--verify", baseRef])[0];
  const headSha = gitLines(cwd, ["rev-parse", "--verify", "HEAD"])[0];
  const mergeBaseSha = gitLines(cwd, ["merge-base", baseRef, "HEAD"])[0];
  const remoteTrackingSha = collectRemoteTrackingSha(cwd, baseRef);
  const changedFiles = collectChangedFiles(cwd, baseRef);
  const pendingCommitCount = input.pendingCommitCount ?? collectPendingCommitCount(cwd, baseRef);
  const ciStatusHints = input.ciStatusHints ?? collectCiStatusHints(cwd, baseRef, changedFiles);
  const commitMessages = input.commitMessages ?? collectCommitMessages(cwd, baseRef);
  const title = input.title ?? titleFromBranch(branchName) ?? firstCommitTitle(commitMessages);
  const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssues([branchName, title, input.body, ...commitMessages].filter(Boolean).join("\n"))])].sort(
    (left, right) => left - right,
  );
  const payload: LocalBranchMetadata = {
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
    validation: input.validation,
    linkedIssues,
    labels: input.labels,
    title,
    body: input.body,
    pendingMergedPrCount: input.pendingMergedPrCount,
    pendingClosedPrCount: input.pendingClosedPrCount,
    approvedPrCount: input.approvedPrCount,
    expectedOpenPrCountAfterMerge: input.expectedOpenPrCountAfterMerge,
    projectedCredibility: input.projectedCredibility,
    scenarioNotes: input.scenarioNotes,
    pendingCommitCount,
    ciStatusHints,
    branchEligibility: input.branchEligibility,
  };
  return stripUndefined(payload);
}

export function collectPendingCommitCount(cwd: string, baseRef: string): number {
  const count = gitLines(cwd, ["rev-list", "--count", `${baseRef}..HEAD`])[0];
  const parsed = Number(count);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function collectCiStatusHints(cwd: string, baseRef: string, changedFiles: ChangedFile[] = []): string[] {
  const hints: string[] = [];
  const paths = changedFiles.map((file) => file.path).filter(Boolean);
  if (paths.some((path) => /^\.github\/workflows\//i.test(path))) {
    hints.push("Workflow files changed; CI required-check behavior may change after merge.");
  }
  if (paths.some((path) => /(^|\/)(Makefile|Dockerfile|package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(path))) {
    hints.push("Build or dependency manifests changed; rerun the repo's standard validation commands.");
  }
  const pendingCommits = collectPendingCommitCount(cwd, baseRef);
  if (pendingCommits > 0) {
    hints.push(`${pendingCommits} local commit(s) ahead of ${baseRef}; push or rebase before reviewers rely on the latest diff.`);
  }
  return hints;
}

export type BranchAnalysisInput = CollectLocalBranchMetadataInput & {
  scorePreviewCommand?: string | undefined;
};

export type BranchAnalysisPayload = LocalBranchMetadata & {
  localScorer: ScorerOutput | MetadataOnlyScorerOutput;
  localScorerStatus: ScorerStatus;
};

export function buildBranchAnalysisPayload(input: BranchAnalysisInput): BranchAnalysisPayload {
  const workspace = resolveWorkspaceCwd(input);
  const metadata = collectLocalBranchMetadata({ ...input, cwd: workspace.cwd });
  const scorerMetadata = { ...metadata, repoRoot: workspace.cwd };
  const scorerCommand = resolveScorePreviewCommand(input);
  const externalPreview = runExternalScorePreview(scorerMetadata, scorerCommand);
  // externalPreview.ok true is only ever set (in runExternalScorePreview) alongside a validated,
  // non-null, non-array object payload -- ScorerStatus's own `payload?: unknown` just can't express
  // that correlation as a discriminated union without a much heavier refactor of this shared type.
  const localScorer = externalPreview.ok
    ? normalizeScorerOutput(externalPreview.payload as Record<string, unknown>)
    : metadataOnlyScorer(externalPreview);
  return {
    ...metadata,
    localScorer,
    localScorerStatus: sanitizeLocalScorerStatus(externalPreview),
  };
}

export type ResolveWorkspaceCwdInput = { cwd?: unknown; workspaceRoots?: McpRootInput[] | undefined };
export type ResolvedWorkspace = { cwd: string; rootsAvailable: boolean; rootCount: number };

export function resolveWorkspaceCwd(input: ResolveWorkspaceCwdInput = {}): ResolvedWorkspace {
  const workspaceRoots = normalizeMcpWorkspaceRoots(input.workspaceRoots);
  if (workspaceRoots.length === 0) {
    return {
      cwd: safeResolvedPath((input.cwd as string | undefined) ?? process.cwd()),
      rootsAvailable: false,
      rootCount: 0,
    };
  }

  const selectedRoot = workspaceRoots[0] as WorkspaceRoot;
  const requestedCwd =
    input.cwd === undefined || input.cwd === null || input.cwd === ""
      ? selectedRoot.path
      : isAbsolute(String(input.cwd))
        ? String(input.cwd)
        : resolve(selectedRoot.path, String(input.cwd));
  const cwd = safeResolvedPath(requestedCwd);
  const containingRoot = workspaceRoots.find((root) => pathIsInside(cwd, root.path));
  if (!containingRoot) {
    throw new Error("Selected workspace is outside the MCP roots exposed by the client.");
  }

  return {
    cwd,
    rootsAvailable: true,
    rootCount: workspaceRoots.length,
  };
}

export function normalizeMcpWorkspaceRoots(roots: McpRootInput[] | undefined): WorkspaceRoot[] {
  if (!Array.isArray(roots)) return [];
  const normalized: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const uri = typeof root?.uri === "string" ? root.uri : "";
    if (!uri.startsWith("file:")) continue;
    try {
      const path = safeResolvedPath(fileURLToPath(uri));
      if (seen.has(path)) continue;
      seen.add(path);
      normalized.push({ path });
    } catch {
      // Ignore non-local or malformed root URIs. Clients without usable roots fall back to cwd.
    }
  }
  return normalized;
}

function safeResolvedPath(path: string): string {
  const resolved = resolve(String(path));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function pathIsInside(candidate: string, root: string): boolean {
  const child = safeResolvedPath(candidate);
  const parent = safeResolvedPath(root);
  const childRelativeToParent = relative(parent, child);
  return childRelativeToParent === "" || (!!childRelativeToParent && !childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent));
}

export function resolveScorePreviewCommand(input: { scorePreviewCommand?: string | undefined } = {}): string | undefined {
  const explicit = input.scorePreviewCommand ?? process.env.GITTENSOR_SCORE_PREVIEW_CMD;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return undefined;
}

export function referenceScorePreviewExample(kind: "metadata" | "gittensor" = "metadata"): string {
  const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
  const interpreter = kind === "gittensor" ? "python3" : "node";
  return `${interpreter} ./node_modules/@loopover/mcp/scripts/${script}`;
}

export function redactScorerCommand(command: unknown): string {
  const text = String(command ?? "").trim();
  if (!text) return text;
  const parts = splitCommand(text);
  const interpreter = parts[0]?.split(/[\\/]/).pop() ?? "command";
  const script = parts.at(-1)?.split(/[\\/]/).pop();
  if (script && /\.(mjs|js|cjs|py)$/i.test(script)) return `${interpreter} <scorer-script>/${script}`;
  return "<configured-scorer-command>";
}

export type ScorerStatus = {
  ok: boolean;
  code?: string | undefined;
  reason?: string | undefined;
  fallbackMode?: string | undefined;
  durationMs?: number | undefined;
  payload?: unknown;
  stderr?: string | undefined;
  exitCode?: number | undefined;
  scorerCommand?: string | undefined;
};

export function sanitizeLocalScorerStatus<T extends ScorerStatus | null | undefined>(status: T): T {
  if (!status || typeof status !== "object") return status;
  return stripUndefined({
    ...status,
    reason: status.reason ? redactLocalPath(String(status.reason)) : undefined,
    stderr: status.stderr ? redactLocalPath(String(status.stderr)) : undefined,
    scorerCommand: status.scorerCommand ? redactScorerCommand(status.scorerCommand) : undefined,
  }) as T;
}

export function runExternalScorePreview(metadata: Record<string, unknown>, scorerCommand: string | undefined): ScorerStatus {
  const timeoutMs = scorePreviewTimeoutMs();
  if (!scorerCommand) {
    return scorerFailure("missing_scorer_command", "GITTENSOR_SCORE_PREVIEW_CMD is not configured.");
  }
  const parts = splitCommand(scorerCommand);
  const command = parts[0];
  const args = parts.slice(1);
  if (!command) {
    return scorerFailure("empty_scorer_command", "GITTENSOR_SCORE_PREVIEW_CMD is empty.");
  }

  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, {
      input: JSON.stringify({
        ...metadata,
        repoRoot: metadata.repoRoot ?? metadata.cwd,
        gittensorRoot: process.env.GITTENSOR_ROOT,
      }),
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const durationMs = Date.now() - startedAt;
    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
        durationMs,
        stderr: truncateText(output),
        fallbackMode: "metadata_only",
      });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return scorerFailure("malformed_json", "External scorer stdout must be a JSON object.", {
        durationMs,
        fallbackMode: "metadata_only",
      });
    }
    const normalized = normalizeScorerOutput(payload as Record<string, unknown>);
    if (normalized.sourceTokenScore === undefined && normalized.totalTokenScore === undefined) {
      return scorerFailure("malformed_json", "External scorer JSON must include sourceTokenScore or totalTokenScore.", {
        durationMs,
        fallbackMode: "metadata_only",
      });
    }
    return stripUndefined({
      ok: true,
      code: "success",
      reason: "external_scorer_succeeded",
      durationMs,
      payload,
      fallbackMode: "external_command",
    });
  } catch (error) {
    return classifyScorerExecFailure(error, Date.now() - startedAt, scorerCommand);
  }
}

export function setupGuidanceForLocalScorer(status: ScorerStatus): string[] {
  if (status.ok) return [];
  const safeStatus = sanitizeLocalScorerStatus(status);
  const code = safeStatus.code ?? inferScorerCode(safeStatus.reason);
  const guidance = [
    "LoopOver used metadata-only analysis because no external scorer succeeded.",
  ];
  switch (code) {
    case "missing_scorer_command":
      guidance.push(`Set GITTENSOR_SCORE_PREVIEW_CMD, for example: export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("metadata")}"`);
      guidance.push(`For tree-sitter scoring with a local gittensor checkout: export GITTENSOR_ROOT=<local-gittensor-checkout> && export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("gittensor")}"`);
      break;
    case "empty_scorer_command":
      guidance.push("GITTENSOR_SCORE_PREVIEW_CMD is set but empty; provide a command that reads branch metadata JSON from stdin.");
      break;
    case "timeout":
      guidance.push(`External scorer exceeded ${scorePreviewTimeoutMs()}ms; simplify the scorer or raise GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS.`);
      break;
    case "malformed_json":
      guidance.push("External scorer must print one JSON object with sourceTokenScore/totalTokenScore fields to stdout.");
      if (safeStatus.stderr) guidance.push(`Last scorer stdout snippet: ${truncateText(safeStatus.stderr, 160)}`);
      break;
    case "non_zero_exit":
      guidance.push("External scorer exited with a non-zero status; inspect stderr and run loopover-mcp doctor.");
      if (safeStatus.stderr) guidance.push(`Scorer stderr: ${truncateText(safeStatus.stderr, 160)}`);
      if (typeof safeStatus.exitCode === "number") guidance.push(`Exit code: ${safeStatus.exitCode}`);
      break;
    default:
      guidance.push("Set GITTENSOR_SCORE_PREVIEW_CMD to a command that reads branch metadata JSON from stdin and emits scoring metrics JSON.");
      if (safeStatus.reason) guidance.push(`Last scorer error: ${safeStatus.reason}`);
      break;
  }
  guidance.push("Local scorer output stays on your machine; LoopOver never uploads source contents.");
  return guidance;
}

export function probeLocalScorer(scorerCommand: string | undefined = resolveScorePreviewCommand()): ScorerStatus {
  return sanitizeLocalScorerStatus(
    runExternalScorePreview(
      {
        repoFullName: "JSONbored/loopover",
        branchName: "doctor-probe",
        changedFiles: [{ path: "src/example.ts", additions: 12, deletions: 2, status: "modified" }],
        repoRoot: process.cwd(),
      },
      scorerCommand,
    ),
  );
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return "";
  }
}

export function gitLines(cwd: string, args: string[]): string[] {
  return gitOutput(cwd, args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectChangedFiles(cwd: string, baseRef: string): ChangedFile[] {
  // Read both halves with `-z`: the human format quotes non-ASCII/control-char paths, so a quoted
  // name-status key would never match the verbatim numstat key and the file's stats would be lost.
  const numstat = new Map(parseNumstat(cwd, baseRef).map((entry) => [entry.path, entry]));
  return parseNameStatus(cwd, baseRef).map((entry) => {
    const stats = numstat.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    return stripUndefined({
      path: entry.path,
      previousPath: entry.previousPath,
      additions: stats.additions,
      deletions: stats.deletions,
      status: statusFromCode(entry.code),
      binary: stats.binary,
    });
  });
}

type NameStatusEntry = { code: string; path: string; previousPath: string | undefined };

function parseNameStatus(cwd: string, baseRef: string): NameStatusEntry[] {
  // `-z`: the status code is its own field and paths are verbatim; a rename is followed by the old
  // then the new path, any other status by a single path.
  const records = gitOutput(cwd, ["diff", "--name-status", "-M", "-z", baseRef, "--"]).split("\0");
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index];
    if (!code) continue;
    const isRename = code.startsWith("R");
    const previousPath = isRename ? records[index + 1] : undefined;
    const path = records[index + (isRename ? 2 : 1)];
    index += isRename ? 2 : 1;
    entries.push({ code, path: path as string, previousPath });
  }
  return entries;
}

type NumstatEntry = { path: string; additions: number; deletions: number; binary: boolean };

function parseNumstat(cwd: string, baseRef: string): NumstatEntry[] {
  // `-z`: paths are verbatim and a rename emits old/new as separate fields, not the lossy
  // "{a => b}" / "a => b" human form that left cross-directory renames keyed by an unmatchable string.
  const records = gitOutput(cwd, ["diff", "--numstat", "-M", "-z", baseRef, "--"]).split("\0");
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const stat = records[index];
    if (!stat) continue;
    const [added, deleted, inlinePath] = splitNumstatStat(stat);
    // An empty inline path marks a rename: the new path is the second of the two following fields.
    let path = inlinePath;
    if (inlinePath === "") {
      path = records[index + 2] as string;
      index += 2;
    }
    const binary = added === "-";
    entries.push({ path: path as string, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
  }
  return entries;
}

function splitNumstatStat(stat: string): [string, string, string] {
  // "<added>\t<deleted>\t<path?>" -- keep the path slice intact even if it contains tabs.
  const firstTab = stat.indexOf("\t");
  const secondTab = stat.indexOf("\t", firstTab + 1);
  return [stat.slice(0, firstTab), stat.slice(firstTab + 1, secondTab), stat.slice(secondTab + 1)];
}

function collectCommitMessages(cwd: string, baseRef: string): string[] {
  const rangeMessages = gitLines(cwd, ["log", "--pretty=%B%x1e", `${baseRef}..HEAD`]).join("\n");
  const messages = rangeMessages
    .split("\u001e")
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length > 0) return messages.slice(0, 30);
  const last = gitLines(cwd, ["log", "-1", "--pretty=%B"]).join("\n").trim();
  return last ? [last] : [];
}

function defaultBaseRef(cwd: string): string {
  const originHead = gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])[0];
  if (originHead) return originHead;
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/main"]).length > 0) return "origin/main";
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/master"]).length > 0) return "origin/master";
  return "HEAD";
}

// baseRef is always a real string here: collectRemoteTrackingSha's sole caller (collectLocalBranchMetadata)
// resolves its own `baseRef` local through `input.baseRef ?? defaultBaseRef(cwd)`, which always ends in a
// string ("HEAD"/"origin/main"/"origin/master" at worst) -- never null/undefined.
function collectRemoteTrackingSha(cwd: string, baseRef: string): string | undefined {
  const match = baseRef.replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
  const branch = match?.[1];
  if (!branch) return undefined;
  const remoteRow = gitLines(cwd, ["ls-remote", "--heads", "origin", branch])[0];
  return remoteRow?.split(/\s+/)[0];
}

export type ScorerOutput = {
  mode: "external_command";
  activeModel?: string | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  warnings?: string[] | undefined;
};

function normalizeScorerOutput(payload: Record<string, unknown>): ScorerOutput {
  const source = payload.source as Record<string, unknown> | undefined;
  const total = payload.total as Record<string, unknown> | undefined;
  const tests = payload.tests as Record<string, unknown> | undefined;
  const nonCode = payload.nonCode as Record<string, unknown> | undefined;
  return stripUndefined({
    mode: "external_command",
    activeModel: stringValue(payload.activeModel ?? payload.active_model),
    sourceTokenScore: numberValue(payload.sourceTokenScore ?? payload.source_token_score ?? source?.tokenScore),
    totalTokenScore: numberValue(payload.totalTokenScore ?? payload.total_token_score ?? total?.tokenScore),
    sourceLines: numberValue(payload.sourceLines ?? payload.source_lines ?? source?.lines),
    testTokenScore: numberValue(payload.testTokenScore ?? payload.test_token_score ?? tests?.tokenScore),
    nonCodeTokenScore: numberValue(payload.nonCodeTokenScore ?? payload.non_code_token_score ?? nonCode?.tokenScore),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : undefined,
  });
}

export type MetadataOnlyScorerOutput = { mode: "metadata_only"; warnings: string[] };

// status.reason is always set here: metadataOnlyScorer's sole caller (buildBranchAnalysisPayload) only
// invokes it with an ok:false ScorerStatus from runExternalScorePreview, and every ok:false branch there
// returns via scorerFailure(code, reason, ...), whose `reason` parameter is required and always a real
// string literal -- so the `?? status.code ?? "external_scorer_unavailable"` fallbacks can never fire.
function metadataOnlyScorer(status: ScorerStatus): MetadataOnlyScorerOutput {
  return {
    mode: "metadata_only",
    warnings: [status.reason as string],
  };
}

function scorerFailure(code: string, reason: string, extra: Partial<ScorerStatus> = {}): ScorerStatus {
  return stripUndefined({
    ok: false,
    code,
    reason,
    fallbackMode: "metadata_only",
    ...extra,
  });
}

function classifyScorerExecFailure(error: unknown, durationMs: number, scorerCommand: string): ScorerStatus {
  const execError = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const output = execError?.output as unknown[] | undefined;
  const stdout = String(execError?.stdout ?? output?.[1] ?? "").trim();
  const stderr = truncateText(String(execError?.stderr ?? output?.[2] ?? ""));
  const exitCode = typeof execError?.status === "number" ? execError.status : undefined;
  if (stdout && !looksLikeScorerJson(stdout)) {
    return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
      durationMs,
      stderr: truncateText(stdout),
      scorerCommand: redactScorerCommand(scorerCommand),
      fallbackMode: "metadata_only",
    });
  }
  if (execError?.code === "ETIMEDOUT" || (execError?.killed && execError?.signal === "SIGTERM")) {
    return scorerFailure("timeout", `External scorer timed out after ${scorePreviewTimeoutMs()}ms.`, { durationMs, stderr, scorerCommand: redactScorerCommand(scorerCommand) });
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return scorerFailure("non_zero_exit", `External scorer exited with status ${exitCode}.`, { durationMs, stderr, exitCode, scorerCommand: redactScorerCommand(scorerCommand) });
  }
  const message = error instanceof Error ? error.message : "external_scorer_failed";
  if (/JSON/i.test(message)) {
    return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", { durationMs, stderr, scorerCommand: redactScorerCommand(scorerCommand) });
  }
  if (stderr && !looksLikeScorerJson(stderr)) {
    return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
      durationMs,
      stderr: truncateText(stderr),
      scorerCommand: redactScorerCommand(scorerCommand),
      fallbackMode: "metadata_only",
    });
  }
  return scorerFailure("scorer_failed", redactLocalPath(message), { durationMs, stderr, exitCode, scorerCommand: redactScorerCommand(scorerCommand) });
}

function looksLikeScorerJson(output: string): boolean {
  try {
    const payload: unknown = JSON.parse(output);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const normalized = normalizeScorerOutput(payload as Record<string, unknown>);
    return normalized.sourceTokenScore !== undefined || normalized.totalTokenScore !== undefined;
  } catch {
    return false;
  }
}

function inferScorerCode(reason: string | undefined): string {
  const text = String(reason ?? "");
  if (text.includes("missing_scorer_command")) return "missing_scorer_command";
  if (text.includes("empty_scorer_command")) return "empty_scorer_command";
  if (/timed out|ETIMEDOUT/i.test(text)) return "timeout";
  if (/JSON/i.test(text)) return "malformed_json";
  if (/status \d+/i.test(text)) return "non_zero_exit";
  return "scorer_failed";
}

function scorePreviewTimeoutMs(): number {
  const parsed = Number(process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS ?? 15000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function truncateText(value: unknown, maxLength = 240): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function splitCommand(command: unknown): string[] {
  return String(command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function assertSourceUploadDisabled(): void {
  if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false")) {
    throw new Error("LOOPOVER_UPLOAD_SOURCE=true is not supported in v1; local MCP sends metadata only.");
  }
}

// Word-boundary the closing keywords (as the server-side extractors in src/db/repositories.ts and
// src/signals/engine.ts already do) so a keyword embedded in a longer word does not spuriously link an
// issue: without \b, `hotfix 5` / `prefixes 12` matched the `fix`/`fixes` substring and captured the
// trailing number. The bare `#` branch stays boundary-free so `#123` still matches anywhere.
export function extractLinkedIssues(text: unknown): number[] {
  const issues: number[] = [];
  for (const match of String(text).matchAll(/(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)|#)\s*#?(\d+)/gi)) issues.push(Number(match[1]));
  return issues.filter((issue) => Number.isInteger(issue) && issue > 0);
}

function statusFromCode(code: string): ChangedFileStatus {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  // parseNameStatus's sole caller (collectChangedFiles) invokes `git diff --name-status -M` -- copy
  // detection ("C" statuses) is only emitted with an explicit `-C` flag, which is never passed here, so
  // this arm is unreachable through this file's own git invocation. Kept (not deleted) because it is
  // still a real git status-letter git diff can produce with different flags, not a made-up case.
  /* v8 ignore next -- see comment above; unreachable given collectChangedFiles' own fixed -M-only flags */
  if (code.startsWith("C")) return "copied";
  // Reachable for real: a type change (e.g. regular file <-> symlink) reports "T" even with -M alone,
  // same for unmerged ("U")/unknown ("X")/broken-pairing ("B") -- none of those map to a known status.
  return "unknown";
}

// branchName is always a real string here: titleFromBranch's sole caller (collectLocalBranchMetadata)
// resolves its own `branchName` local through a `??` chain that ends in the "local-branch" literal, so
// it is provably never null/undefined -- no `?? ""` fallback needed to keep String() safe.
function titleFromBranch(branchName: string): string | undefined {
  const title = branchName
    .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return title || undefined;
}

function firstCommitTitle(messages: string[]): string | undefined {
  return messages.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim();
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)])) as T;
}
