import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCodeFile, isTestPath as isTestFile } from "@loopover/engine/signals/test-evidence";
import { redactLocalPath } from "./redact-local-path.js";
export { isCodeFile, isTestFile };
export { redactLocalPath };
function stripTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47)
        end -= 1;
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
        if (match?.[1] && match[2])
            return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
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
    if (!repoFullName)
        throw new Error("Could not infer repoFullName from git remote; pass --repo owner/repo.");
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
    const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssues([branchName, title, input.body, ...commitMessages].filter(Boolean).join("\n"))])].sort((left, right) => left - right);
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
    const requestedCwd = input.cwd === undefined || input.cwd === null || input.cwd === ""
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
    if (!Array.isArray(roots))
        return [];
    const normalized = [];
    const seen = new Set();
    for (const root of roots) {
        const uri = typeof root?.uri === "string" ? root.uri : "";
        if (!uri.startsWith("file:"))
            continue;
        try {
            const path = safeResolvedPath(fileURLToPath(uri));
            if (seen.has(path))
                continue;
            seen.add(path);
            normalized.push({ path });
        }
        catch {
            // Ignore non-local or malformed root URIs. Clients without usable roots fall back to cwd.
        }
    }
    return normalized;
}
function safeResolvedPath(path) {
    const resolved = resolve(String(path));
    try {
        return realpathSync(resolved);
    }
    catch {
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
    if (typeof explicit === "string" && explicit.trim())
        return explicit.trim();
    return undefined;
}
export function referenceScorePreviewExample(kind = "metadata") {
    const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
    const interpreter = kind === "gittensor" ? "python3" : "node";
    return `${interpreter} ./node_modules/@loopover/mcp/scripts/${script}`;
}
export function redactScorerCommand(command) {
    const text = String(command ?? "").trim();
    if (!text)
        return text;
    const parts = splitCommand(text);
    const interpreter = parts[0]?.split(/[\\/]/).pop() ?? "command";
    const script = parts.at(-1)?.split(/[\\/]/).pop();
    if (script && /\.(mjs|js|cjs|py)$/i.test(script))
        return `${interpreter} <scorer-script>/${script}`;
    return "<configured-scorer-command>";
}
export function sanitizeLocalScorerStatus(status) {
    if (!status || typeof status !== "object")
        return status;
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
        }
        catch {
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
    }
    catch (error) {
        return classifyScorerExecFailure(error, Date.now() - startedAt, scorerCommand);
    }
}
export function setupGuidanceForLocalScorer(status) {
    if (status.ok)
        return [];
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
            if (safeStatus.stderr)
                guidance.push(`Last scorer stdout snippet: ${truncateText(safeStatus.stderr, 160)}`);
            break;
        case "non_zero_exit":
            guidance.push("External scorer exited with a non-zero status; inspect stderr and run loopover-mcp doctor.");
            if (safeStatus.stderr)
                guidance.push(`Scorer stderr: ${truncateText(safeStatus.stderr, 160)}`);
            if (typeof safeStatus.exitCode === "number")
                guidance.push(`Exit code: ${safeStatus.exitCode}`);
            break;
        default:
            guidance.push("Set GITTENSOR_SCORE_PREVIEW_CMD to a command that reads branch metadata JSON from stdin and emits scoring metrics JSON.");
            if (safeStatus.reason)
                guidance.push(`Last scorer error: ${safeStatus.reason}`);
            break;
    }
    guidance.push("Local scorer output stays on your machine; LoopOver never uploads source contents.");
    return guidance;
}
export function probeLocalScorer(scorerCommand = resolveScorePreviewCommand()) {
    return sanitizeLocalScorerStatus(runExternalScorePreview({
        repoFullName: "JSONbored/loopover",
        branchName: "doctor-probe",
        changedFiles: [{ path: "src/example.ts", additions: 12, deletions: 2, status: "modified" }],
        repoRoot: process.cwd(),
    }, scorerCommand));
}
function gitOutput(cwd, args) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    }
    catch {
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
        if (!code)
            continue;
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
        if (!stat)
            continue;
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
    if (messages.length > 0)
        return messages.slice(0, 30);
    const last = gitLines(cwd, ["log", "-1", "--pretty=%B"]).join("\n").trim();
    return last ? [last] : [];
}
function defaultBaseRef(cwd) {
    const originHead = gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])[0];
    if (originHead)
        return originHead;
    if (gitLines(cwd, ["rev-parse", "--verify", "origin/main"]).length > 0)
        return "origin/main";
    if (gitLines(cwd, ["rev-parse", "--verify", "origin/master"]).length > 0)
        return "origin/master";
    return "HEAD";
}
function collectRemoteTrackingSha(cwd, baseRef) {
    const match = String(baseRef ?? "").replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
    const branch = match?.[1];
    if (!branch)
        return undefined;
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
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return false;
        const normalized = normalizeScorerOutput(payload);
        return normalized.sourceTokenScore !== undefined || normalized.totalTokenScore !== undefined;
    }
    catch {
        return false;
    }
}
function inferScorerCode(reason) {
    const text = String(reason ?? "");
    if (text.includes("missing_scorer_command"))
        return "missing_scorer_command";
    if (text.includes("empty_scorer_command"))
        return "empty_scorer_command";
    if (/timed out|ETIMEDOUT/i.test(text))
        return "timeout";
    if (/JSON/i.test(text))
        return "malformed_json";
    if (/status \d+/i.test(text))
        return "non_zero_exit";
    return "scorer_failed";
}
function scorePreviewTimeoutMs() {
    const parsed = Number(process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS ?? 15000);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}
function truncateText(value, maxLength = 240) {
    const text = String(value ?? "").trim();
    if (!text)
        return undefined;
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
function splitCommand(command) {
    return String(command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}
function assertSourceUploadDisabled() {
    if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false")) {
        throw new Error("LOOPOVER_UPLOAD_SOURCE=true is not supported in v1; local MCP sends metadata only.");
    }
}
// Word-boundary the closing keywords (as the server-side extractors in src/db/repositories.ts and
// src/signals/engine.ts already do) so a keyword embedded in a longer word does not spuriously link an
// issue: without \b, `hotfix 5` / `prefixes 12` matched the `fix`/`fixes` substring and captured the
// trailing number. The bare `#` branch stays boundary-free so `#123` still matches anywhere.
export function extractLinkedIssues(text) {
    const issues = [];
    for (const match of String(text).matchAll(/(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)|#)\s*#?(\d+)/gi))
        issues.push(Number(match[1]));
    return issues.filter((issue) => Number.isInteger(issue) && issue > 0);
}
function statusFromCode(code) {
    if (code.startsWith("A"))
        return "added";
    if (code.startsWith("M"))
        return "modified";
    if (code.startsWith("D"))
        return "deleted";
    if (code.startsWith("R"))
        return "renamed";
    if (code.startsWith("C"))
        return "copied";
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
function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map(stripUndefined);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtYnJhbmNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9jYWwtYnJhbmNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxRCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxJQUFJLFVBQVUsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzlGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUV6RCxPQUFPLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxlQUFlLEVBQUUsQ0FBQztBQWtFM0IsU0FBUyxvQkFBb0IsQ0FBQyxLQUFhO0lBQ3pDLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDdkIsT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUU7UUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzdELE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sVUFBVSxjQUFjLENBQUMsU0FBaUI7SUFDOUMsTUFBTSxPQUFPLEdBQUcsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3JFLE1B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Q3pDLE9BQU8sTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUM7U0FDNUIsT0FBTyxDQUFDLHdCQUF3QixFQUFFLEVBQUUsQ0FBQztTQUNyQyxPQUFPLENBQUMsUUFBUSxFQUFFLEdBQUcsQ0FBQztTQUN0QixJQUFJLEVBQUUsQ0FBQztBQUNaLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLFFBQWtCO0lBQzFDLE9BQU8sUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUM7QUFDdkYsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzdCLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDdEQsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUN2RSxDQUFDO0FBRUQsU0FBUyxjQUFjLENBQUksS0FBUTtJQUNqQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBTSxDQUFDO0lBQ2hFLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3RELE9BQU8sTUFBTSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxFQUFFLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFNLENBQUM7QUFDdkosQ0FBQyJ9