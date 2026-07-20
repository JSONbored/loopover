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
        // metadata.title is provably defined here: this call always resolves branchName through the same
        // "??...??\"local-branch\"" chain collectLocalBranchMetadata itself uses (collectLocalDiff has no
        // way to override branchName to force it empty), and titleFromBranch("local-branch") is non-empty.
        title: metadata.title,
        commitMessage: metadata.commitMessages.join("\n\n").trim(),
        changedFiles: metadata.changedFiles.map((file) => file.path),
        // file.additions/deletions are always real numbers here (ChangedFile's own type, always populated by
        // collectChangedFiles) -- collectLocalDiff has no way to inject a differently-shaped changedFiles.
        changedLineCount: metadata.changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0),
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
    // externalPreview.ok true is only ever set (in runExternalScorePreview) alongside a validated,
    // non-null, non-array object payload -- ScorerStatus's own `payload?: unknown` just can't express
    // that correlation as a discriminated union without a much heavier refactor of this shared type.
    const localScorer = externalPreview.ok
        ? normalizeScorerOutput(externalPreview.payload)
        : metadataOnlyScorer(externalPreview);
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
        entries.push({ code, path: path, previousPath });
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
        entries.push({ path: path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
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
// baseRef is always a real string here: collectRemoteTrackingSha's sole caller (collectLocalBranchMetadata)
// resolves its own `baseRef` local through `input.baseRef ?? defaultBaseRef(cwd)`, which always ends in a
// string ("HEAD"/"origin/main"/"origin/master" at worst) -- never null/undefined.
function collectRemoteTrackingSha(cwd, baseRef) {
    const match = baseRef.replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
    const branch = match?.[1];
    if (!branch)
        return undefined;
    const remoteRow = gitLines(cwd, ["ls-remote", "--heads", "origin", branch])[0];
    return remoteRow?.split(/\s+/)[0];
}
function normalizeScorerOutput(payload) {
    const source = payload.source;
    const total = payload.total;
    const tests = payload.tests;
    const nonCode = payload.nonCode;
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
// status.reason is always set here: metadataOnlyScorer's sole caller (buildBranchAnalysisPayload) only
// invokes it with an ok:false ScorerStatus from runExternalScorePreview, and every ok:false branch there
// returns via scorerFailure(code, reason, ...), whose `reason` parameter is required and always a real
// string literal -- so the `?? status.code ?? "external_scorer_unavailable"` fallbacks can never fire.
function metadataOnlyScorer(status) {
    return {
        mode: "metadata_only",
        warnings: [status.reason],
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
    const output = execError?.output;
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
    // parseNameStatus's sole caller (collectChangedFiles) invokes `git diff --name-status -M` -- copy
    // detection ("C" statuses) is only emitted with an explicit `-C` flag, which is never passed here, so
    // this arm is unreachable through this file's own git invocation. Kept (not deleted) because it is
    // still a real git status-letter git diff can produce with different flags, not a made-up case.
    /* v8 ignore next -- see comment above; unreachable given collectChangedFiles' own fixed -M-only flags */
    if (code.startsWith("C"))
        return "copied";
    // Reachable for real: a type change (e.g. regular file <-> symlink) reports "T" even with -M alone,
    // same for unmerged ("U")/unknown ("X")/broken-pairing ("B") -- none of those map to a known status.
    return "unknown";
}
// branchName is always a real string here: titleFromBranch's sole caller (collectLocalBranchMetadata)
// resolves its own `branchName` local through a `??` chain that ends in the "local-branch" literal, so
// it is provably never null/undefined -- no `?? ""` fallback needed to keep String() safe.
function titleFromBranch(branchName) {
    const title = branchName
        .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
        .replace(/[-_]+/g, " ")
        .trim();
    return title || undefined;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtYnJhbmNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9jYWwtYnJhbmNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxVQUFVLEVBQVEsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUNoRSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxJQUFJLFVBQVUsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzlGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUV6RCxPQUFPLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxlQUFlLEVBQUUsQ0FBQztBQThFM0IsU0FBUyxvQkFBb0IsQ0FBQyxLQUFhO0lBQ3pDLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDdkIsT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUU7UUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzdELE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sVUFBVSxjQUFjLENBQUMsU0FBa0I7SUFDL0MsTUFBTSxPQUFPLEdBQUcsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3JFLE1B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