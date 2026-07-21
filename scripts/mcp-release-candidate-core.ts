import YAML from "yaml";
import { normalizeNewlines } from "./mcp-release-core.js";
import { MCP_PACKAGE_ALLOWED_FILE_PATTERNS } from "./mcp-package-allowlist.js";

/**
 * Pure, deterministic checks for the MCP release-candidate dry-run.
 *
 * Every function here is side-effect free so it can be unit tested with fixtures
 * and reused by the CLI runner. None of these functions read tokens, npm
 * credentials, GitHub auth, environment dumps, or absolute local paths; the
 * {@link redactSensitive} helper scrubs any such content before it is printed.
 *
 * The release tag format mirrors the publish workflow trigger (`mcp-v*.*.*`) and
 * the changelog section format produced by {@link renderReleaseSection}.
 */

export const RELEASE_TAG_PATTERN = /^mcp-v(\d+)\.(\d+)\.(\d+)$/;

// Canonical allowlist lives in mcp-package-allowlist.ts (shared with check-mcp-package.mjs).
export { MCP_PACKAGE_ALLOWED_FILE_PATTERNS };
const ALLOWED_FILE_PATTERNS = MCP_PACKAGE_ALLOWED_FILE_PATTERNS;
const FORBIDDEN_PATH_PATTERN = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const SECRET_CONTENT_PATTERN = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;
const NPM_TOKEN_PATTERN = /(NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM[A-Z_]*|_authToken|npm_[A-Za-z0-9]{20,})/;

export type CheckResult = {
  ok: boolean;
  code: string;
  message: string;
};

export type TarballCheckResult = CheckResult & {
  unexpected: string[];
  secretFiles: string[];
};

export type TokenlessCheckResult = CheckResult & {
  issues: string[];
};

export type ReleaseCandidateReport = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; code: string; message: string }>;
  failures: Array<{ name: string; ok: boolean; code: string; message: string }>;
  nextSteps: string[];
};

/** Parse a release tag, returning whether it is well-formed and its semver. */
export function parseReleaseTag(tag: string | null | undefined): { valid: boolean; version: string | null } {
  const match = RELEASE_TAG_PATTERN.exec(String(tag ?? "").trim());
  if (!match) return { valid: false, version: null };
  return { valid: true, version: `${match[1]}.${match[2]}.${match[3]}` };
}

/** The canonical tag for a package version. */
export function expectedReleaseTag(version: string): string {
  return `mcp-v${version}`;
}

/** Verify the intended tag is well-formed and matches the package version. */
export function checkTag({ tag, packageVersion }: { tag: string | null | undefined; packageVersion: string | null | undefined }): CheckResult {
  const parsed = parseReleaseTag(tag);
  if (!parsed.valid) {
    return { ok: false, code: "tag_format_invalid", message: `Release tag "${tag}" must be mcp-v<major>.<minor>.<patch> (for example mcp-v${packageVersion ?? "0.0.0"}).` };
  }
  if (!packageVersion) {
    return { ok: false, code: "package_version_missing", message: "Could not read the MCP package version to compare against the tag." };
  }
  if (parsed.version !== packageVersion) {
    return { ok: false, code: "tag_version_mismatch", message: `Release tag ${tag} (${parsed.version}) does not match packages/loopover-mcp/package.json version ${packageVersion}.` };
  }
  return { ok: true, code: "tag_ok", message: `Release tag ${tag} matches package version ${packageVersion}.` };
}

/** Whether the changelog contains a real, dated section for the target version. */
export function changelogHasVersionSection(changelog: string | null | undefined, version: string | null | undefined): boolean {
  if (!changelog || !version) return false;
  const pattern = new RegExp(`^## mcp-v${escapeRegExp(version)} - \\S`, "m");
  return pattern.test(normalizeNewlines(changelog));
}

/** Verify the MCP changelog has a target-version section. */
export function checkChangelog({ changelog, version }: { changelog: string | null | undefined; version: string }): CheckResult {
  if (changelogHasVersionSection(changelog, version)) {
    return { ok: true, code: "changelog_ok", message: `MCP changelog has a dated section for mcp-v${version}.` };
  }
  return { ok: false, code: "changelog_section_missing", message: `MCP changelog is missing a "## mcp-v${version} - <date>" section.` };
}

/** Files that fall outside the publish allowlist (unexpected or forbidden). */
export function unexpectedTarballFiles(files: string[] | null | undefined): string[] {
  return (files ?? []).map((file) => String(file)).filter((file) => FORBIDDEN_PATH_PATTERN.test(file) || !ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(file)));
}

/** Whether a file's content carries secret-like material. */
export function fileLooksLikeSecret(content: string | null | undefined): boolean {
  return SECRET_CONTENT_PATTERN.test(String(content ?? ""));
}

/** Verify the packed tarball only contains allowlisted files with no secret-like content. */
export function checkTarball({ files, contentsByFile }: { files: string[] | null | undefined; contentsByFile?: Record<string, string> }): TarballCheckResult {
  const unexpected = unexpectedTarballFiles(files);
  const secretFiles = Object.entries(contentsByFile ?? {})
    .filter(([, content]) => fileLooksLikeSecret(content))
    .map(([file]) => file)
    .sort();
  const ok = unexpected.length === 0 && secretFiles.length === 0;
  const problems: string[] = [];
  if (unexpected.length > 0) problems.push(`unexpected file(s): ${unexpected.join(", ")}`);
  if (secretFiles.length > 0) problems.push(`secret-like content in: ${secretFiles.join(", ")}`);
  return {
    ok,
    code: ok ? "tarball_ok" : "tarball_unsafe",
    message: ok
      ? `Tarball contents are within the publish allowlist with no secret-like content (${(files ?? []).length} file(s)).`
      : `Tarball is unsafe to publish — ${problems.join("; ")}.`,
    unexpected,
    secretFiles,
  };
}

/** Verify the publish workflow uses tokenless trusted publishing (OIDC + provenance, no npm token). */
export function checkTokenlessPublish(workflowYaml: string | null | undefined): TokenlessCheckResult {
  const yaml = String(workflowYaml ?? "");
  const issues: string[] = [];
  const workflow = parseWorkflowYaml(yaml);
  const publishJobs = findPublishJobs(workflow);
  if (publishJobs.length === 0) {
    issues.push("publish workflow is missing an active 'npm publish' step");
  }
  if (publishJobs.some((job) => !hasIdTokenWrite(job.job?.permissions) && !hasIdTokenWrite(workflow?.permissions))) {
    issues.push("publish job is missing 'id-token: write' for trusted publishing");
  }
  if (publishJobs.some((job) => job.publishRuns.some((run) => !hasEnabledProvenanceFlag(run)))) {
    issues.push("publish step is missing '--provenance'");
  }
  if (NPM_TOKEN_PATTERN.test(JSON.stringify(workflow ?? {}))) issues.push("publish workflow references an npm auth token — trusted publishing must stay tokenless");
  const ok = issues.length === 0;
  return {
    ok,
    code: ok ? "publish_tokenless" : "publish_token_risk",
    issues,
    message: ok ? "Publish workflow uses tokenless trusted publishing (id-token + provenance, no npm token)." : `Publish workflow provenance/tokenless config needs attention — ${issues.join("; ")}.`,
  };
}

// The workflow YAML this parses is untyped external config (an arbitrary GitHub Actions workflow file) that
// this module itself only ever probes loosely (typeof/Array.isArray checks, never a full schema) -- typing it
// `any` here matches what the code actually relies on rather than forcing a schema this file doesn't validate.
function parseWorkflowYaml(yaml: string): any {
  try {
    const parsed = YAML.parse(yaml);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function findPublishJobs(workflow: any): Array<{ job: any; publishRuns: string[] }> {
  return Object.values(workflow?.jobs ?? {})
    .filter((job: any) => job && typeof job === "object")
    .map((job: any) => ({
      job,
      publishRuns: (Array.isArray(job.steps) ? job.steps : [])
        .map((step: any) => (step && typeof step === "object" ? String(step.run ?? "") : ""))
        .filter((run: string) => /\bnpm(?:@[^\s]+)?\s+publish\b/.test(run)),
    }))
    .filter((job: any) => job.publishRuns.length > 0);
}

function hasIdTokenWrite(permissions: any): boolean {
  return permissions && typeof permissions === "object" && String(permissions["id-token"] ?? "").toLowerCase() === "write";
}

function hasEnabledProvenanceFlag(run: string): boolean {
  return run
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .some((line) => /(^|\s)--provenance(?:\s|$)/.test(line));
}

const REMEDIATION: Record<string, string> = {
  tag_format_invalid: "Use an mcp-v<major>.<minor>.<patch> tag that matches the package version.",
  package_version_missing: "Restore a valid version in packages/loopover-mcp/package.json.",
  tag_version_mismatch: "Align the tag with packages/loopover-mcp/package.json (and the CLI packageVersion) before tagging.",
  changelog_section_missing: "Run npm run changelog:mcp and commit the generated mcp-v<version> changelog section.",
  tarball_unsafe: "Remove unexpected or secret-bearing files from the package and rerun the dry-run.",
  cli_smoke_failed: "Fix the packed CLI so `loopover-mcp --help` exits cleanly before tagging.",
  publish_token_risk: "Restore tokenless trusted publishing (id-token: write + --provenance, no npm token) in publish-mcp.yml.",
};

/** Aggregate individual check results into a pass/fail report with next steps. */
export function buildReleaseCandidateReport(checks: Record<string, (CheckResult & { tag?: string }) | undefined>): ReleaseCandidateReport {
  const entries = Object.entries(checks)
    .filter((entry): entry is [string, CheckResult & { tag?: string }] => Boolean(entry[1]) && typeof entry[1] === "object")
    .map(([name, result]) => ({ name, ok: Boolean(result.ok), code: result.code, message: result.message }));
  const failures = entries.filter((entry) => !entry.ok);
  const ok = failures.length === 0;
  const nextSteps = ok
    ? ["Release candidate looks safe to tag.", `Create and push ${checks.tag?.tag ?? "the mcp-v<version> tag"} to start the tokenless publish workflow.`, "No publish was attempted by this dry-run."]
    : [...failures.map((failure) => REMEDIATION[failure.code] ?? `Resolve: ${failure.message}`), "Re-run the release-candidate dry-run; do not tag until it passes."];
  return { ok, checks: entries, failures, nextSteps };
}

/** Scrub tokens, npm credentials, GitHub auth, and absolute local paths from any log line. */
export function redactSensitive(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/gts_[0-9a-f]{64}/g, "[redacted-token]")
    .replace(/npm_[A-Za-z0-9]{20,}/g, "[redacted-token]")
    .replace(/\/\/registry\.npmjs\.org\/:_authToken=\S+/g, "//registry.npmjs.org/:_authToken=[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY))=\S+/g, "$1=[redacted]")
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"';]*/g, "[local-path]");
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
