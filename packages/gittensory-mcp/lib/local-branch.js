import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function parseGitRemote(remoteUrl) {
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

export function collectLocalDiff(cwd, baseRef, workspaceRoots) {
  const metadata = collectLocalBranchMetadata({ cwd, baseRef, login: "local", workspaceRoots });
  return {
    title: metadata.title ?? "Local diff preflight",
    commitMessage: metadata.commitMessages.join("\n\n").trim(),
    changedFiles: metadata.changedFiles.map((file) => file.path),
    changedLineCount: metadata.changedFiles.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0),
    testFiles: metadata.changedFiles.map((file) => file.path).filter(isTestFile),
    codeFiles: metadata.changedFiles.map((file) => file.path).filter(isCodeFile),
  };
}

export function collectLocalBranchMetadata(input) {
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
  const payload = {
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

export function collectPendingCommitCount(cwd, baseRef) {
  const count = gitLines(cwd, ["rev-list", "--count", `${baseRef}..HEAD`])[0];
  const parsed = Number(count);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function collectCiStatusHints(cwd, baseRef, changedFiles = []) {
  const hints = [];
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

export function buildBranchAnalysisPayload(input) {
  const workspace = resolveWorkspaceCwd(input);
  const metadata = collectLocalBranchMetadata({ ...input, cwd: workspace.cwd });
  const scorerMetadata = { ...metadata, repoRoot: workspace.cwd };
  const scorerCommand = resolveScorePreviewCommand(input);
  const externalPreview = runExternalScorePreview(scorerMetadata, scorerCommand);
  const localScorer = externalPreview.ok ? normalizeScorerOutput(externalPreview.payload) : metadataOnlyScorer(externalPreview);
  return {
    ...metadata,
    localScorer,
    localScorerStatus: sanitizeLocalScorerStatus(externalPreview),
  };
}

export function resolveWorkspaceCwd(input = {}) {
  const workspaceRoots = normalizeMcpWorkspaceRoots(input.workspaceRoots);
  if (workspaceRoots.length === 0) {
    return {
      cwd: safeResolvedPath(input.cwd ?? process.cwd()),
      rootsAvailable: false,
      rootCount: 0,
    };
  }

  const selectedRoot = workspaceRoots[0];
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

export function normalizeMcpWorkspaceRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const normalized = [];
  const seen = new Set();
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

function safeResolvedPath(path) {
  const resolved = resolve(String(path));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function pathIsInside(candidate, root) {
  const child = safeResolvedPath(candidate);
  const parent = safeResolvedPath(root);
  const childRelativeToParent = relative(parent, child);
  return childRelativeToParent === "" || (!!childRelativeToParent && !childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent));
}

export function resolveScorePreviewCommand(input = {}) {
  const explicit = input.scorePreviewCommand ?? process.env.GITTENSOR_SCORE_PREVIEW_CMD;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return undefined;
}

export function referenceScorePreviewCommand(kind = "metadata") {
  const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
  const interpreter = kind === "gittensor" ? "python3" : "node";
  return `${interpreter} ${join(packageRoot, "scripts", script)}`;
}

export function referenceScorePreviewExample(kind = "metadata") {
  const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
  const interpreter = kind === "gittensor" ? "python3" : "node";
  return `${interpreter} ./node_modules/@jsonbored/gittensory-mcp/scripts/${script}`;
}

export function redactLocalPath(value) {
  const text = String(value ?? "");
  if (!text) return text;
  return text
    .replace(/(?:~\/|[A-Za-z]:\\)[^\s"'`,;)]+/g, "<local-path>")
    .replace(/(^|[\s"'`=])\/(?:[^\s"'`,;)]+(?:\/[^\s"'`,;)]+)*)/g, (_, prefix) => `${prefix}<local-path>`);
}

export function redactScorerCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return text;
  const parts = splitCommand(text);
  const interpreter = parts[0]?.split(/[\\/]/).pop() ?? "command";
  const script = parts.at(-1)?.split(/[\\/]/).pop();
  if (script && /\.(mjs|js|cjs|py)$/i.test(script)) return `${interpreter} <scorer-script>/${script}`;
  return "<configured-scorer-command>";
}

export function sanitizeLocalScorerStatus(status) {
  if (!status || typeof status !== "object") return status;
  return stripUndefined({
    ...status,
    reason: status.reason ? redactLocalPath(String(status.reason)) : undefined,
    stderr: status.stderr ? redactLocalPath(String(status.stderr)) : undefined,
    scorerCommand: status.scorerCommand ? redactScorerCommand(status.scorerCommand) : undefined,
  });
}

export function runExternalScorePreview(metadata, scorerCommand) {
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
    let payload;
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
    const normalized = normalizeScorerOutput(payload);
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

export function setupGuidanceForLocalScorer(status) {
  if (status.ok) return [];
  const safeStatus = sanitizeLocalScorerStatus(status);
  const code = safeStatus.code ?? inferScorerCode(safeStatus.reason);
  const guidance = [
    "Gittensory used metadata-only analysis because no external scorer succeeded.",
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
      guidance.push("External scorer exited with a non-zero status; inspect stderr and run gittensory-mcp doctor.");
      if (safeStatus.stderr) guidance.push(`Scorer stderr: ${truncateText(safeStatus.stderr, 160)}`);
      if (typeof safeStatus.exitCode === "number") guidance.push(`Exit code: ${safeStatus.exitCode}`);
      break;
    default:
      guidance.push("Set GITTENSOR_SCORE_PREVIEW_CMD to a command that reads branch metadata JSON from stdin and emits scoring metrics JSON.");
      if (safeStatus.reason) guidance.push(`Last scorer error: ${safeStatus.reason}`);
      break;
  }
  guidance.push("Local scorer output stays on your machine; Gittensory never uploads source contents.");
  return guidance;
}

export function probeLocalScorer(scorerCommand = resolveScorePreviewCommand()) {
  return sanitizeLocalScorerStatus(
    runExternalScorePreview(
    {
      repoFullName: "JSONbored/gittensory",
      branchName: "doctor-probe",
      changedFiles: [{ path: "src/example.ts", additions: 12, deletions: 2, status: "modified" }],
      repoRoot: process.cwd(),
    },
      scorerCommand,
    ),
  );
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return "";
  }
}

export function gitLines(cwd, args) {
  return gitOutput(cwd, args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectChangedFiles(cwd, baseRef) {
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

function parseNameStatus(cwd, baseRef) {
  // `-z`: the status code is its own field and paths are verbatim; a rename is followed by the old
  // then the new path, any other status by a single path.
  const records = gitOutput(cwd, ["diff", "--name-status", "-M", "-z", baseRef, "--"]).split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index];
    if (!code) continue;
    const isRename = code.startsWith("R");
    const previousPath = isRename ? records[index + 1] : undefined;
    const path = records[index + (isRename ? 2 : 1)];
    index += isRename ? 2 : 1;
    entries.push({ code, path, previousPath });
  }
  return entries;
}

function parseNumstat(cwd, baseRef) {
  // `-z`: paths are verbatim and a rename emits old/new as separate fields, not the lossy
  // "{a => b}" / "a => b" human form that left cross-directory renames keyed by an unmatchable string.
  const records = gitOutput(cwd, ["diff", "--numstat", "-M", "-z", baseRef, "--"]).split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const stat = records[index];
    if (!stat) continue;
    const [added, deleted, inlinePath] = splitNumstatStat(stat);
    // An empty inline path marks a rename: the new path is the second of the two following fields.
    let path = inlinePath;
    if (inlinePath === "") {
      path = records[index + 2];
      index += 2;
    }
    const binary = added === "-";
    entries.push({ path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
  }
  return entries;
}

function splitNumstatStat(stat) {
  // "<added>\t<deleted>\t<path?>" -- keep the path slice intact even if it contains tabs.
  const firstTab = stat.indexOf("\t");
  const secondTab = stat.indexOf("\t", firstTab + 1);
  return [stat.slice(0, firstTab), stat.slice(firstTab + 1, secondTab), stat.slice(secondTab + 1)];
}

function collectCommitMessages(cwd, baseRef) {
  const rangeMessages = gitLines(cwd, ["log", "--pretty=%B%x1e", `${baseRef}..HEAD`]).join("\n");
  const messages = rangeMessages
    .split("\u001e")
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length > 0) return messages.slice(0, 30);
  const last = gitLines(cwd, ["log", "-1", "--pretty=%B"]).join("\n").trim();
  return last ? [last] : [];
}

function defaultBaseRef(cwd) {
  const originHead = gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])[0];
  if (originHead) return originHead;
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/main"]).length > 0) return "origin/main";
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/master"]).length > 0) return "origin/master";
  return "HEAD";
}

function collectRemoteTrackingSha(cwd, baseRef) {
  const match = String(baseRef ?? "").replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
  const branch = match?.[1];
  if (!branch) return undefined;
  const remoteRow = gitLines(cwd, ["ls-remote", "--heads", "origin", branch])[0];
  return remoteRow?.split(/\s+/)[0];
}

function normalizeScorerOutput(payload) {
  return stripUndefined({
    mode: "external_command",
    activeModel: stringValue(payload.activeModel ?? payload.active_model),
    sourceTokenScore: numberValue(payload.sourceTokenScore ?? payload.source_token_score ?? payload.source?.tokenScore),
    totalTokenScore: numberValue(payload.totalTokenScore ?? payload.total_token_score ?? payload.total?.tokenScore),
    sourceLines: numberValue(payload.sourceLines ?? payload.source_lines ?? payload.source?.lines),
    testTokenScore: numberValue(payload.testTokenScore ?? payload.test_token_score ?? payload.tests?.tokenScore),
    nonCodeTokenScore: numberValue(payload.nonCodeTokenScore ?? payload.non_code_token_score ?? payload.nonCode?.tokenScore),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : undefined,
  });
}

function metadataOnlyScorer(status) {
  return {
    mode: "metadata_only",
    warnings: [status.reason ?? status.code ?? "external_scorer_unavailable"],
  };
}

function scorerFailure(code, reason, extra = {}) {
  return stripUndefined({
    ok: false,
    code,
    reason,
    fallbackMode: "metadata_only",
    ...extra,
  });
}

function classifyScorerExecFailure(error, durationMs, scorerCommand) {
  const execError = error && typeof error === "object" ? error : undefined;
  const stdout = String(execError?.stdout ?? execError?.output?.[1] ?? "").trim();
  const stderr = truncateText(execError?.stderr ?? execError?.output?.[2] ?? "");
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

function looksLikeScorerJson(output) {
  try {
    const payload = JSON.parse(output);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const normalized = normalizeScorerOutput(payload);
    return normalized.sourceTokenScore !== undefined || normalized.totalTokenScore !== undefined;
  } catch {
    return false;
  }
}

function inferScorerCode(reason) {
  const text = String(reason ?? "");
  if (text.includes("missing_scorer_command")) return "missing_scorer_command";
  if (text.includes("empty_scorer_command")) return "empty_scorer_command";
  if (/timed out|ETIMEDOUT/i.test(text)) return "timeout";
  if (/JSON/i.test(text)) return "malformed_json";
  if (/status \d+/i.test(text)) return "non_zero_exit";
  return "scorer_failed";
}

function scorePreviewTimeoutMs() {
  const parsed = Number(process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS ?? 15000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

function truncateText(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function splitCommand(command) {
  return String(command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function assertSourceUploadDisabled() {
  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false")) {
    throw new Error("GITTENSORY_UPLOAD_SOURCE=true is not supported in v1; local MCP sends metadata only.");
  }
}

function extractLinkedIssues(text) {
  const issues = [];
  for (const match of String(text).matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|#)\s*#?(\d+)/gi)) issues.push(Number(match[1]));
  return issues.filter((issue) => Number.isInteger(issue) && issue > 0);
}

function statusFromCode(code) {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  return "unknown";
}

function titleFromBranch(branchName) {
  return String(branchName ?? "")
    .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function firstCommitTitle(messages) {
  return messages.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim();
}

function isTestFile(file) {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file)
  );
}

function isCodeFile(file) {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
