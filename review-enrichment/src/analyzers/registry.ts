import { scanActionPins } from "./actions-pin.js";
import { scanApprovalIntegrity } from "./approval-integrity.js";
import { scanAssetWeight } from "./asset-weight.js";
import { scanChurnHotspot } from "./churn-hotspot.js";
import { scanBlameLink } from "./blame-link.js";
import { scanCiCheckSignals } from "./ci-check-signals.js";
import { scanCodeowners } from "./codeowners.js";
import { scanCommitHygiene } from "./commit-hygiene.js";
import { scanCommitSignature } from "./commit-signature.js";
import { dependencyAnalyzer } from "./dependency/descriptor.js";
import { scanDependencyDiffInventory } from "./dependency-diff.js";
import { scanDocCommentDrift } from "./doc-comment-drift.js";
import { scanDuplication } from "./duplication-scan.js";
import { scanEol } from "./eol-check.js";
import { scanHardcodedUrl } from "./hardcoded-url.js";
import { scanHeavyDependencies } from "./heavy-dependency.js";
import { scanHistory } from "./history.js";
import { scanIacMisconfig } from "./iac-misconfig.js";
import { scanInstallScripts } from "./install-scripts.js";
import { scanLicenses } from "./license-check.js";
import { scanLockfileDrift } from "./lockfile-drift.js";
import { scanNativeBuild } from "./native-build.js";
import { scanPendingReviewRequests } from "./pending-review-requests.js";
import { scanProvenance } from "./provenance.js";
import { scanRedos } from "./redos.js";
import { secretAnalyzer } from "./secret/descriptor.js";
import { scanSecretLog } from "./secret-log.js";
import { scanStaleBranch } from "./stale-branch.js";
import { scanTestRatio } from "./test-ratio.js";
import { scanMigrationSafety } from "./migration-safety.js";
import { scanLooseRanges } from "./loose-range.js";
import { scanMagicNumbers } from "./magic-number.js";
import { scanConflictMarkers } from "./conflict-marker.js";
import { scanDebugLeftover } from "./debug-leftover.js";
import { scanDeepNesting } from "./deep-nesting.js";
import { scanI18nRegression } from "./i18n-regression.js";
import { scanErrorSwallow } from "./error-swallow.js";
import { scanFloatingPromise } from "./floating-promise.js";
import { scanSizeSmell } from "./size-smell.js";
import { scanA11yRegression } from "./a11y-regression.js";
import { scanCommitLint } from "./commit-lint.js";
import { scanUnsafeAny } from "./unsafe-any.js";
import { scanTerminology } from "./terminology.js";
import { scanTodoMarker } from "./todo-marker.js";
import { scanTyposquat } from "./typosquat.js";
import { scanUndocumentedExport } from "./undocumented-export.js";
import { scanUnusedExport } from "./unused-export.js";
import { scanExhaustivenessDrift } from "./exhaustiveness-drift.js";
import { scanFlakyTest } from "./flaky-test.js";
import { scanApiBreak } from "./api-break.js";
import { scanDeprecatedDependencies } from "./deprecated-dep.js";
import type {
  AnalyzerDescriptor,
  AnalyzerFn,
  AnalyzerName,
  AnalyzerRegistry,
  AnyAnalyzerDescriptor,
} from "./types.js";

function descriptor<Name extends AnalyzerName>(
  definition: AnalyzerDescriptor<Name>,
): AnalyzerDescriptor<Name> {
  return definition;
}

export const ANALYZER_DESCRIPTORS = [
  dependencyAnalyzer,
  descriptor({
    name: "dependencyDiff",
    title: "Dependency inventory changes",
    category: "supply-chain",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxManifestFiles: 20, maxPatchLinesPerFile: 500 },
    docs: {
      summary:
        "Summarizes direct dependency add/remove/version-change deltas in changed manifest patches — informational, not a CVE scan.",
      looksAt: "Added/removed lines in package.json, requirements.txt, and go.mod diffs.",
      reports: "Ecosystem, package name, direction (add/remove/change), and from/to versions.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Distinct from the dependency CVE analyzer: this is the neutral inventory delta only. Reuses the same manifest line parsers.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Dependency inventory changes (direct manifest delta)"];
      for (const item of findings) {
        const detail =
          item.direction === "add"
            ? `added @ ${helpers.safeCodeSpan(item.to ?? "?")}`
            : item.direction === "remove"
              ? `removed (was ${helpers.safeCodeSpan(item.from ?? "?")})`
              : `${helpers.safeCodeSpan(item.from ?? "?")} → ${helpers.safeCodeSpan(item.to ?? "?")}`;
        lines.push(
          `- ${helpers.safeCodeSpan(item.package)} (${helpers.safeCodeSpan(item.ecosystem)}) — ${helpers.safeCodeSpan(item.direction)}: ${detail}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanDependencyDiffInventory(req, signal),
  }),
  descriptor({
    name: "lockfileDrift",
    title: "Lockfile drift",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: {
      maxLockfileFiles: 12,
      maxPatchLinesPerFile: 1200,
      maxOsvQueries: 40,
    },
    docs: {
      summary:
        "Finds vulnerable transitive dependency versions introduced only through lockfile changes.",
      looksAt:
        "package-lock.json, yarn.lock, and poetry.lock patches, excluding packages already named in a changed manifest.",
      reports:
        "Lockfile line, package/version, ecosystem, direction, and OSV vulnerability details.",
      network: "Calls OSV.dev querybatch. No GitHub token required.",
      notes:
        "Useful when a PR does not touch a top-level manifest but changes resolved dependency pins.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanLockfileDrift(req, fetch, { signal, analysis, diagnostics }),
  }),
  secretAnalyzer,
  descriptor({
    name: "license",
    title: "Dependency licenses",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxLicenseLookups: 25 },
    docs: {
      summary: "Checks licenses for newly added or upgraded dependencies.",
      looksAt: "The same direct dependency changes used by the dependency analyzer.",
      reports:
        "Copyleft or unknown license classifications that need maintainer compatibility review.",
      network: "Calls deps.dev. No GitHub token required.",
      notes: "Permissive and otherwise-known licenses are intentionally silent.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanLicenses(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "installScript",
    title: "npm install scripts",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    docs: {
      summary: "Flags npm packages that run lifecycle hooks during install.",
      looksAt: "New or upgraded npm dependencies.",
      reports: "Package, version, hook names, and publish date when available.",
      network: "Calls the npm registry. No GitHub token required.",
      notes:
        "The script body is not returned, which keeps the brief compact and non-executable.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanInstallScripts(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "heavyDependency",
    title: "Heavy dependencies used trivially",
    category: "performance",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxWeightLookups: 20, maxFindings: 15 },
    docs: {
      summary:
        "Flags materially heavy npm dependencies used only a few times in changed lines.",
      looksAt: "New or upgraded npm dependencies plus direct uses in added lines.",
      reports:
        "Package size, dependency count, usage count, and line-cited usage locations.",
      network: "Calls Bundlephobia. No GitHub token required.",
      notes:
        "Only reports packages with trivial direct usage so the finding stays actionable.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanHeavyDependencies(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "hardcodedUrl",
    title: "Hardcoded URLs and endpoints",
    category: "config",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000, maxHostChars: 40 },
    docs: {
      summary:
        "Flags absolute HTTP(S) URLs and raw IP:port endpoints newly added in non-test, non-config source.",
      looksAt: "Added lines in changed source files, excluding tests, config manifests, and comment/import lines.",
      reports: "File, line, kind (http-url or ip-endpoint), and a redacted host — never full paths or queries.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "localhost, 127.0.0.1, and example.com are allowlisted. Distinct from the secret scanner — no credential detection.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Hardcoded URLs/endpoints (should usually come from config)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.kind)} host ${helpers.safeCodeSpan(item.host)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanHardcodedUrl(req, signal),
  }),
  descriptor({
    name: "actionPin",
    title: "Unpinned GitHub Actions",
    category: "supply-chain",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    docs: {
      summary: "Detects third-party workflow actions pinned to mutable tags or branches.",
      looksAt: "Added uses: lines in .github/workflows YAML patches.",
      reports: "Workflow file, line, action, and mutable ref.",
      network: "Pure local analyzer. No external network call.",
      notes: "Official actions/* and github/* actions are excluded to keep the signal focused.",
    },
    run: (req) => scanActionPins(req),
  }),
  descriptor({
    name: "eol",
    title: "End-of-life runtimes",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxFiles: 40, maxPatchLines: 1000, maxPins: 80 },
    docs: {
      summary: "Checks changed runtime and base-image pins against EOL calendars.",
      looksAt:
        "Dockerfile FROM lines, version-manager pin files (.nvmrc, .python-version, …), Heroku runtime.txt, Gemfile ruby directives, and go.mod runtime pins.",
      reports:
        "File, product, version, EOL date, and whether the release is already EOL or close to EOL.",
      network: "Calls endoflife.date. No GitHub token required.",
      notes: "Only changed pins are checked; existing old runtimes outside the PR are not reported.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanEol(req, fetch, Date.now(), { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "redos",
    title: "ReDoS-prone regex",
    category: "security",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxPatternChars: 1000, maxLineChars: 2000 },
    docs: {
      summary: "Finds newly introduced regex shapes that can catastrophically backtrack.",
      looksAt: "Regex literals and RegExp constructor string arguments in added lines.",
      reports: "File, line, and a truncated vulnerable pattern.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Structural and precision-first; it flags nested unbounded quantifier shapes such as (a+)+.",
    },
    run: (req) => scanRedos(req),
  }),
  descriptor({
    name: "provenance",
    title: "Provenance and committed artifacts",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxAttestationChecks: 20, maxFindings: 30 },
    docs: {
      summary: "Checks package attestations and reviewability of newly added artifacts.",
      looksAt: "New npm/PyPI dependency versions plus added binary, vendored, and minified files.",
      reports:
        "Missing attestations, binary files without reviewable source, and vendored or minified code.",
      network:
        "Calls npm and PyPI attestation/provenance endpoints for package checks. Path checks are local.",
      notes: "Network failures fail safe; it flags only confident no-attestation responses.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanProvenance(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "codeowners",
    title: "CODEOWNERS coverage",
    category: "ownership",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "author", "github-token"],
    limits: {
      maxFilesReported: 20,
      maxCodeownersBytes: 64 * 1024,
      maxCodeownersRules: 1000,
    },
    docs: {
      summary: "Checks whether changed files cross ownership domains not owned by the PR author.",
      looksAt: ".github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS plus the changed file list.",
      reports:
        "Owned files where the PR author is not listed, plus ownership blast-radius context in the rendered brief.",
      network:
        "Calls the GitHub API. Requires author plus GitHub token forwarding for private repos.",
      notes:
        "Leave REES_FORWARD_GITHUB_TOKEN unset/false to disable token forwarding; this analyzer will then skip when it cannot read CODEOWNERS.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanCodeowners(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "secretLog",
    title: "Secrets or PII in logs",
    category: "security",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary: "Flags added code that writes sensitive values to logs or stdout.",
      looksAt: "Added lines that call console, logger, process.stdout, or process.stderr sinks.",
      reports: "File, line, sink, and category: secret, pii, or request-object.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "String log messages are stripped before matching, so ordinary prose like password reset is not enough to trigger.",
    },
    run: (req, { signal }) => scanSecretLog(req, signal),
  }),
  descriptor({
    name: "assetWeight",
    title: "Heavy binary assets",
    category: "performance",
    cost: "github-heavy",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: { maxFindings: 50 },
    docs: {
      summary:
        "Finds large binary assets added to a PR, and growth deltas when base size is available.",
      looksAt:
        "Changed binary assets such as images, fonts, archives, PDFs, videos, and compiled binaries.",
      reports: "Path, size, delta, and whether the asset was added or grown.",
      network:
        "Calls the GitHub API. Requires headSha and GitHub token forwarding for private repos.",
      notes:
        "Added asset detection works from headSha. Growth comparison needs baseSha in the enrichment request.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanAssetWeight(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "typosquat",
    title: "Typosquat and dependency-confusion risk",
    category: "supply-chain",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxDeps: 50, maxConfusionQueries: 15 },
    docs: {
      summary:
        "Checks newly added dependency names for near-miss and publicly claimable package names.",
      looksAt: "Newly added npm and PyPI dependency names.",
      reports:
        "Typosquat matches against popular packages, or unscoped names missing from the public registry.",
      network:
        "Uses bundled popular-package lists plus npm/PyPI registry lookups for dependency-confusion checks.",
      notes:
        "Scoped npm packages are treated as namespace-protected and are not flagged as typosquats.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanTyposquat(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "commitSignature",
    title: "Head commit signature",
    category: "supply-chain",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token", "head-sha"],
    docs: {
      summary: "Checks head commit signature and public author provenance.",
      looksAt: "The head commit plus a bounded slice of recent repository commit history.",
      reports:
        "GitHub signature verification reason and public boolean provenance flags.",
      network:
        "Calls the GitHub API. Requires headSha and GitHub token forwarding for private repos.",
      notes:
        "Does not expose emails or private identity data; only public GitHub commit facts are surfaced.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanCommitSignature(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "iacMisconfig",
    title: "IaC / config misconfiguration",
    category: "config",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary: "Flags risky IaC/config changes such as public buckets or insecure CORS.",
      looksAt: "Added lines in Docker, Terraform, YAML, JSON, and similar config files.",
      reports: "File, line, and public-safe rule kind.",
      network: "Pure local analyzer. No external network call.",
      notes: "Reports configuration shapes only; it does not inspect private runtime config.",
    },
    run: (req, { signal }) => scanIacMisconfig(req, signal),
  }),
  descriptor({
    name: "nativeBuild",
    title: "Native-build dependencies",
    category: "performance",
    cost: "registry",
    defaultEnabled: true,
    requires: ["files", "public-network"],
    limits: { maxQueries: 25, maxRegistryJsonBytes: 2 * 1024 * 1024 },
    docs: {
      summary:
        "Flags newly-added dependencies that compile native code or ship sdist-only builds.",
      looksAt: "New npm/PyPI dependency versions.",
      reports: "Package, version, ecosystem, native-build kind, and public-safe reason.",
      network: "Calls npm and PyPI registries. No GitHub token required.",
      notes:
        "Registry JSON is capped so large package metadata cannot monopolize REES memory.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanNativeBuild(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "history",
    title: "Author and change-area history",
    category: "history",
    cost: "github-heavy",
    defaultEnabled: true,
    requires: ["files", "github-token", "author"],
    limits: {
      maxFilesProbed: 5,
      commitsPerFile: 10,
      maxPrLookups: 12,
      maxSimilarPrs: 8,
    },
    docs: {
      summary: "Shows public author track record, same-file PR history, and linked-issue alignment.",
      looksAt:
        "The PR author, changed file paths, linked issue text, added diff lines, and bounded GitHub history lookups.",
      reports:
        "Prior PR counts, similar past PRs, linked issue coverage, and partial/degraded status.",
      network:
        "Calls GitHub API with bounded fanout. Requires author plus GitHub token forwarding for private repos.",
      notes:
        "Returns partial findings when GitHub lookups are skipped, capped, or budget-exhausted.",
    },
    run: (req, context) =>
      scanHistory(req, fetch, {
        signal: context.signal,
        deadlineMs: context.deadlineMs,
        timeoutMs: context.timeoutMs,
        diagnostics: context.diagnostics,
        analysis: context.analysis,
      }),
  }),
  descriptor({
    name: "docCommentDrift",
    title: "Doc-comment drift",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: { maxFiles: 20, maxFindings: 50 },
    docs: {
      summary:
        "Flags a JSDoc/TSDoc @param that names a parameter the PR removed or renamed but left documented.",
      looksAt:
        "Changed TS/JS source files at headSha, comparing each named function's old vs new parameter list.",
      reports: "File, line, function, and the stale parameter name(s).",
      network: "Calls the GitHub API for changed file contents. Requires headSha and token forwarding for private repos.",
      notes:
        "Conservative: only named function declarations with confidently-enumerable params; non-parameter signature edits are not reported.",
    },
    run: (req, { signal }) => scanDocCommentDrift(req, fetch, { signal }),
  }),
  descriptor({
    name: "duplication",
    title: "Near-verbatim duplicated code",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: {
      minRun: 8,
      maxCandidates: 40,
      maxFetches: 30,
      maxFindings: 25,
      maxFileBytes: 500_000,
    },
    docs: {
      summary:
        "Flags added code that is a near-verbatim duplicate of a block already present elsewhere in the repo.",
      looksAt:
        "Added diff hunks in changed source files compared against same-extension repo files fetched from the git tree at headSha.",
      reports:
        "The head file:line, the existing source file:line it duplicates, and the matched line count.",
      network:
        "Calls the GitHub API for the git tree and candidate blobs. Requires headSha and token forwarding for private repos.",
      notes:
        "Conservative: trivial/boilerplate lines are dropped and a long contiguous run is required, so incidental overlap is not flagged. Never returns code content.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanDuplication(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "churnHotspot",
    title: "Churn hotspots",
    category: "history",
    cost: "github-heavy",
    defaultEnabled: true,
    requires: ["files", "github-token"],
    limits: { maxFilesProbed: 8, windowDays: 90, perPage: 100 },
    docs: {
      summary:
        "Flags changed files that are statistical fragility hotspots — high commit frequency and a high fix/revert fraction.",
      looksAt:
        "Each changed file's recent commit history (a 90-day window), excluding lockfiles, generated output, and binaries.",
      reports: "File, commit count, fix/revert count, and the window — counts only, never file contents.",
      network: "Calls the GitHub commits API once per probed file. Requires GitHub token forwarding for private repos.",
      notes:
        "Distinct from the history analyzer's author track record; this scores the change AREA's defect density.",
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanChurnHotspot(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "blameLink",
    title: "Recent file history (last PR to touch)",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token"],
    limits: { maxFilesProbed: 6, maxLookups: 12 },
    docs: {
      summary:
        "For files this PR modifies or deletes, surfaces the last PR to touch each file — file-level history context, not per-line blame.",
      looksAt:
        "Each changed file's most recent base-branch commit (bounded to the first few files) and that commit's associated PR.",
      reports: "File, a pointer to where this PR changes it, the last-touching PR number, and a short commit-SHA prefix — never file contents.",
      network: "Calls the GitHub commits API and the commit→PR association API, both bounded by a total lookup cap.",
      notes:
        "File-level, not per-line: it reports each file's most recent prior toucher, never claiming a specific line's origin. Fail-safe and partial on cap.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Recent history of changed files (last PR to touch each, file-level)"];
      for (const item of findings) {
        const toucher =
          item.lastTouchedByPr !== undefined
            ? `#${item.lastTouchedByPr}`
            : item.lastTouchedByShaPrefix
              ? `commit ${helpers.safeCodeSpan(item.lastTouchedByShaPrefix)}`
              : "an unknown prior change";
        lines.push(
          `- ${helpers.safeCodeSpan(item.file)} (this PR changes it around old line ${item.line}) was last touched by ${toucher}`,
        );
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanBlameLink(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "approvalIntegrity",
    title: "Review/approval integrity",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token", "head-sha"],
    limits: { maxPages: 10, reviewsPerPage: 100 },
    docs: {
      summary:
        "Flags review/approval integrity signals: an APPROVED review that predates the current head commit, the author approving their own PR, and a reviewer whose current review is still CHANGES_REQUESTED.",
      looksAt:
        "The PR's reviews (walked page by page, bounded), reduced to each reviewer's most recent submitted review — GitHub's own semantics for a reviewer's current vote.",
      reports: "Reviewer login, the finding kind, and (for a stale approval) a short commit-SHA prefix — never review body text.",
      network: "Calls the GitHub PR-reviews API, paginated and bounded to a fixed page cap.",
      notes:
        "Structured-fields-only: reads state/commit_id/user.login/submitted_at, never diff or review-body text. Fail-safe on missing token/head SHA/fetch error.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Review/approval integrity"];
      for (const item of findings) {
        if (item.kind === "stale-approval") {
          lines.push(
            `- ${helpers.safeCodeSpan(item.reviewer)}'s approval predates the current head commit (reviewed ${helpers.safeCodeSpan(item.reviewedShaPrefix)})`,
          );
        } else if (item.kind === "self-approval") {
          lines.push(`- ${helpers.safeCodeSpan(item.reviewer)} approved their own PR`);
        } else {
          lines.push(`- ${helpers.safeCodeSpan(item.reviewer)}'s current review is still requesting changes`);
        }
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanApprovalIntegrity(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "ciCheckSignals",
    title: "CI check-run signals",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token", "head-sha"],
    limits: { maxCheckRuns: 100, longRunThresholdMinutes: 15 },
    docs: {
      summary:
        "Flags a named check that only went green after one or more earlier non-success attempts at the current head commit, and any completed check run whose duration crossed a fixed threshold.",
      looksAt:
        "The head commit's check-runs (one bounded page), grouped by name and ordered by start time.",
      reports: "Check name and either the count of failed attempts before success, or the run's duration in minutes — never logs or output.",
      network: "Calls the GitHub check-runs API once, bounded to one page.",
      notes:
        "Structured-fields-only: reads name/status/conclusion/started_at/completed_at, never check output or logs. Fail-safe on missing token/head SHA/fetch error.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### CI check-run signals"];
      for (const item of findings) {
        if (item.kind === "retried-after-failure") {
          const attempt = item.failedAttempts === 1 ? "attempt" : "attempts";
          lines.push(
            `- ${helpers.safeCodeSpan(item.checkName)} only passed after ${item.failedAttempts} earlier non-success ${attempt} at this commit`,
          );
        } else {
          const minute = item.durationMinutes === 1 ? "minute" : "minutes";
          lines.push(`- ${helpers.safeCodeSpan(item.checkName)} ran for ${item.durationMinutes} ${minute}`);
        }
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanCiCheckSignals(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "undocumentedExport",
    title: "Undocumented public exports",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: { maxFiles: 10, maxFindings: 30 },
    docs: {
      summary:
        "Flags exports newly added to a package's public entrypoint (an index.* barrel) that ship with no adjacent doc comment.",
      looksAt:
        "Direct `export const/let/var/function/class/interface/type/enum` declarations added to changed index.* files, checked against the file fetched at headSha.",
      reports: "File, line, and symbol name of each undocumented added export — never file contents.",
      network: "One GitHub contents fetch per changed entrypoint (at headSha). Requires GitHub token forwarding for private repos.",
      notes:
        "Conservative: re-export lists (`export { x }`) and `export *` are ignored; a preceding `//` line (except tool directives like `eslint-disable`) or a real JSDoc `/**` block counts as documented (a plain `/* … */` block does not).",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Undocumented public exports (new public surface with no doc comment)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} exports ${helpers.safeCodeSpan(item.symbol)} with no adjacent doc comment`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanUndocumentedExport(req, fetch, { signal }),
  }),
  descriptor({
    name: "staleBranch",
    title: "Stale branch signal",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token", "head-sha"],
    limits: { behindThreshold: 100 },
    docs: {
      summary:
        "Flags a PR whose head is significantly behind the repo's current default branch — a staleness risk a clean `mergeable` check alone would not surface.",
      looksAt: "The repo's current default branch and how many commits behind it the PR's head is (the GitHub compare API).",
      reports: "The default branch name and the commit count behind it — never commit content.",
      network: "Calls the GitHub repo API once and the compare API once.",
      notes:
        "Structured-fields-only: reads default_branch and behind_by, never diff or commit text. Fail-safe on missing token/head SHA/either fetch failing.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Stale branch signal"];
      for (const item of findings) {
        lines.push(
          `- This PR is ${item.behindBy} commits behind ${helpers.safeCodeSpan(item.defaultBranch)}`,
        );
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanStaleBranch(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "commitHygiene",
    title: "Commit-history hygiene",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token"],
    limits: { maxCommits: 100, maxFindings: 25 },
    docs: {
      summary:
        "Flags commit-history hygiene issues: a merge commit pulled into the PR's own history, a commit left with git's fixup!/squash! autosquash marker, and a commit carrying a Co-authored-by trailer.",
      looksAt: "The PR's commits (one bounded page) — each commit's message subject/trailers and parent count.",
      reports: "A short commit-SHA prefix, the finding kind, and (for fixup/co-author) the subject line or co-author — never full diff/file content.",
      network: "Calls the GitHub PR-commits API once, bounded to one page.",
      notes:
        "Structured-fields-only: reads commit.message and parents, matched one line at a time, never cross-line state. Fail-safe on missing token/fetch error.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Commit-history hygiene"];
      for (const item of findings) {
        if (item.kind === "merge-commit-in-history") {
          lines.push(`- ${helpers.safeCodeSpan(item.shaPrefix)} is a merge commit pulled into this PR's own history`);
        } else if (item.kind === "fixup-commit-present") {
          lines.push(`- ${helpers.safeCodeSpan(item.shaPrefix)} is an unsquashed fixup/squash commit: ${helpers.safeCodeSpan(item.subject)}`);
        } else {
          lines.push(`- ${helpers.safeCodeSpan(item.shaPrefix)} credits a co-author: ${helpers.safeCodeSpan(item.coAuthor)}`);
        }
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanCommitHygiene(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "pendingReviewRequests",
    title: "Pending review-request staleness",
    category: "history",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token"],
    limits: { staleThresholdHours: 48, maxTimelinePages: 5 },
    docs: {
      summary:
        "Flags a reviewer or team whose review request has been outstanding 48+ hours with no response yet.",
      looksAt: "The PR's currently pending requested reviewers/teams, matched against the issue timeline's review_requested events (bounded, page-confirmed complete).",
      reports: "The reviewer login (or team:slug) and hours pending — never review content.",
      network: "Calls the GitHub requested-reviewers API once and the issue-timeline API, paginated and bounded to a fixed page cap.",
      notes:
        "Structured-fields-only: reads user.login/team.slug/event/created_at, never diff or comment text. Fail-safe on missing token/fetch error/an unconfirmed-complete timeline.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Pending review-request staleness"];
      for (const item of findings) {
        lines.push(`- ${helpers.safeCodeSpan(item.reviewer)}'s review request has been pending for ${item.hoursPending}h`);
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanPendingReviewRequests(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "testRatio",
    title: "Test-to-code ratio",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { materialSourceLines: 20, ratioThreshold: 0.3 },
    docs: {
      summary: "Flags a PR whose source change is material but ships with disproportionately little (or zero) accompanying test change.",
      looksAt: "Each changed file's path (classified source vs test by naming convention) and added-line count.",
      reports: "Source/test added-line and file counts and the resulting ratio — never file content.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "A cheap, always-available complement to the coverage-delta analyzer: works even when no CI coverage artifact exists.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Test-to-code ratio"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`+${item.sourceAdded} source`)} vs ${helpers.safeCodeSpan(`+${item.testAdded} test`)} added lines (ratio ${item.ratio.toFixed(2)}) across ${item.sourceFiles} source file(s) and ${item.testFiles} test file(s)`,
        );
      }
      return lines;
    },
    run: (req) => scanTestRatio(req),
  }),
  descriptor({
    name: "migrationSafety",
    title: "SQL migration safety",
    category: "config",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 20, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags risky schema operations in added migration SQL: drops, renames, non-nullable columns without a default, and blocking table rewrites.",
      looksAt: "Added lines in migration paths (migrations/, db/migrate/, *.sql).",
      reports: "File, line, and public-safe rule kind — never SQL content.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Detection is line-anchored single-statement shapes only; statements split across lines are skipped rather than tracked with cross-line state.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const explain = (kind: (typeof findings)[number]["kind"]): string => {
        switch (kind) {
          case "drop":
            return "drops a table or column; still-running deployments that read the old schema break immediately";
          case "rename":
            return "renames a table or column in one step; code still using the old name fails until fully rolled out";
          case "not-null-no-default":
            return "adds a NOT NULL column without a DEFAULT; inserts from not-yet-updated code omit it and fail";
          case "blocking-rewrite":
            return "changes a column type, which rewrites (and locks) the table in most engines while it runs";
        }
      };
      const lines = ["### SQL migration safety (deploy-breaking schema changes)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${explain(item.kind)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanMigrationSafety(req, signal),
  }),
  descriptor({
    name: "looseRange",
    title: "Loose dependency version range",
    category: "supply-chain",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 20, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags newly-added npm dependency specifiers that use dangerously loose ranges instead of a pinned/caret/tilde range.",
      looksAt: "Added specifier lines in package.json patches.",
      reports: "Manifest file, line, package, raw specifier, and loose-range kind.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Judges only the version specifier, never the package; wildcard, latest, unbounded >=, and bare-major ranges let any future publish flow into the next install.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const explain = (kind: (typeof findings)[number]["kind"]): string => {
        switch (kind) {
          case "wildcard":
            return "a wildcard range accepts ANY published version, including a compromised one";
          case "latest":
            return "the `latest` dist-tag floats to whatever is published next; installs are not reproducible";
          case "unbounded-gte":
            return "an unbounded `>=` range accepts every future major version, breaking changes included";
          case "bare":
            return "a bare-major range floats across every future minor/patch of the major line";
        }
      };
      const lines = ["### Loose dependency version ranges (supply-chain drift risk)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.package}@"${item.range}"`)} (${helpers.safeCodeSpan(`${item.file}:${item.line}`)}) — ${explain(item.kind)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanLooseRanges(req, signal),
  }),
  descriptor({
    name: "terminology",
    title: "Non-inclusive terminology",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags non-inclusive terms newly added in identifiers or comments (whitelist/blacklist, master/slave) and suggests the neutral replacement.",
      looksAt: "Added lines in any changed file, tokenized on camelCase/snake_case/word boundaries.",
      reports: "File, line, the matched term, and the suggested replacement.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Token-based matching avoids substring false positives (masterclass/postmaster are never flagged), and URLs are skipped. The term→suggestion table is a bounded in-file policy.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Non-inclusive terminology (suggested neutral replacements)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.term)} → ${helpers.safeCodeSpan(item.suggestion)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanTerminology(req, signal),
  }),
  descriptor({
    name: "todoMarker",
    title: "Incomplete-work markers",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000, maxNoteChars: 120 },
    docs: {
      summary:
        "Surfaces TODO/FIXME/HACK/XXX markers a PR adds in comments, so a reviewer sees the change is shipping known-incomplete work.",
      looksAt: "Added lines with an uppercase, comment-anchored marker across any changed file.",
      reports: "File, line, tag, and a truncated note.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Precision-first: only UPPERCASE, comment-anchored markers are reported (a lowercase `todo` identifier or a marker inside a string literal is never flagged); a bare marker inside a multi-line block comment is intentionally not matched.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Incomplete-work markers (TODO/FIXME/HACK/XXX added by this PR)"];
      for (const item of findings) {
        const note = item.note ? `: ${item.note}` : "";
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.tag)}${helpers.promptText(note)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanTodoMarker(req, signal),
  }),
  descriptor({
    name: "magicNumber",
    title: "Magic numbers",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags newly-added non-trivial numeric literals in non-test source where a named constant would clarify intent.",
      looksAt:
        "Added lines in source files, excluding tests, strings, comments, trivial sentinels/scales, named constants, array indexes, and enum-like initializers.",
      reports: "File, line, and numeric literal text only.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Precision-first: common values such as 0, 1, -1, 2, 100, 1000, and powers of ten are silent.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Magic numbers (new unexplained numeric literals)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} adds ${helpers.safeCodeSpan(item.value)}; consider naming the intent with a constant`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanMagicNumbers(req, signal),
  }),
  descriptor({
    name: "conflictMarker",
    title: "Leftover conflict markers",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25 },
    docs: {
      summary:
        "Flags leftover VCS conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) accidentally committed in added lines.",
      looksAt: "Added lines in every changed file.",
      reports: "File, line, and the marker shape — never line content.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Structural: an exactly-seven-character marker run at column 0. The ambiguous `=======` separator is not flagged in Markdown/AsciiDoc files, where it is a legitimate section rule.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Leftover conflict markers (unresolved merge/rebase — must be removed)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.marker)}`,
        );
      }
      return lines;
    },
    run: (req) => scanConflictMarkers(req),
  }),
  descriptor({
    name: "debugLeftover",
    title: "Debug leftovers",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags debugging leftovers a PR adds in non-test source — `debugger;`, bare console sinks, or `print()` calls.",
      looksAt: "Added lines in changed non-test source files.",
      reports: "File, line, and kind: debugger, console, or print.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Distinct from the secrets-in-logs analyzer: this catches plain debug noise regardless of payload. String literals are stripped before matching.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Debug leftovers (debugger / console / print added by this PR)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.kind)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanDebugLeftover(req, signal),
  }),
  descriptor({
    name: "sizeSmell",
    title: "Size smells",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxFileLines: 400, maxFunctionLines: 60, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags maintainability size smells from patch structure: an estimated resulting file length or an added function body span that exceeds configured thresholds.",
      looksAt: "Unified-diff hunk headers and added non-test source lines.",
      reports: "File, kind (long-file or big-function), measured size, threshold, and optional function name.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "File length is estimated from hunk headers (the visible patch), not a full checkout. Function detection is structural (`function` / arrow-with-brace) and counts added body lines until brace balance returns to zero.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Size smells (long file or big function added by this PR)"];
      for (const item of findings) {
        const where = item.line ? `${item.file}:${item.line}` : item.file;
        const label =
          item.kind === "long-file"
            ? `estimated ${item.measure} lines (threshold ${item.threshold})`
            : `${helpers.safeCodeSpan(item.name ?? "function")} body ${item.measure} added lines (threshold ${item.threshold})`;
        lines.push(`- ${helpers.safeCodeSpan(where)} — ${helpers.safeCodeSpan(item.kind)}: ${label}`);
      }
      return lines;
    },
    run: (req, { signal }) => scanSizeSmell(req, signal),
  }),
  descriptor({
    name: "floatingPromise",
    title: "Floating promises",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000, maxCallChars: 40 },
    docs: {
      summary:
        "Flags newly-added promise-shaped calls whose returned promise is neither awaited, returned, voided, nor same-line .then/.catch-chained.",
      looksAt: "Added lines in changed non-test TS/JS source files.",
      reports: "File, line, and a truncated callee name (fetch, Promise.*, or *Async suffix).",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Precision-first: bare expression statements only — assignments and non-promise callees are skipped. Structural heuristic, not a type checker.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Floating promises (async call not awaited/returned/chained)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.call)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanFloatingPromise(req, signal),
  }),
  descriptor({
    name: "deepNesting",
    title: "Deep control-flow nesting",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxDepth: 4, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags newly-added control-flow blocks whose nesting depth exceeds a threshold inside a contiguous run of added lines.",
      looksAt: "Added lines in changed non-test source files within each hunk.",
      reports: "File, line, measured control-flow depth, and configured threshold.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Counts braces opened by if/for/while/switch/try/catch/else/do/with, arrow bodies, and function bodies — not object-literal braces. Resets across context lines.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Deep nesting (control-flow depth added by this PR)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — depth ${item.depth} (threshold ${item.threshold})`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanDeepNesting(req, signal),
  }),
  descriptor({
    name: "errorSwallow",
    title: "Swallowed errors",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags newly-added catch/except blocks that swallow the error — empty body, unused binding, or a bare `return null`.",
      looksAt: "Added lines in changed non-test JS/TS/Python source files.",
      reports: "File, line, and kind: empty-catch, unused-binding, or return-null.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Multiline catch bodies are collected with brace balance. Catches that log, rethrow, or reference the binding are not flagged. Brace counting is character-level (string literals are not stripped).",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Swallowed errors (empty catch / unused binding / return null)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.kind)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanErrorSwallow(req, signal),
  }),
  descriptor({
    name: "unsafeAny",
    title: "Unsafe any (TS)",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Counts and locates explicit `any` annotations, `<any>` assertions, and `as any` casts newly introduced in TypeScript diffs.",
      looksAt: "Added lines in changed non-test .ts/.tsx/.mts/.cts source files.",
      reports: "File, line, and kind: annotation, cast, or assertion.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Structural regex only (no type-checker). String literals and comment lines are skipped; findings are capped.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Unsafe any (explicit any introduced by this PR)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.kind)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanUnsafeAny(req, signal),
  }),
  descriptor({
    name: "a11y",
    title: "Accessibility regressions",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "Flags common accessibility regressions in newly added JSX/HTML markup lines.",
      looksAt:
        "Added lines in changed non-test .jsx/.tsx/.html/.vue files for missing img alt text, click-only handlers, unlabeled controls, and positive tabindex.",
      reports:
        "File, line, and rule: img-alt, click-events-have-key-events, label-control, or positive-tabindex.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Structural markup heuristics only — buttons/links and controls with aria-label/id associations are not flagged.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Accessibility regressions (added markup)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.rule)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanA11yRegression(req, signal),
  }),
  descriptor({
    name: "i18n",
    title: "i18n regressions",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxFindings: 25, maxLineChars: 2000 },
    docs: {
      summary:
        "When the diff shows a translation convention, flags newly-added user-facing JSX text or label/title props that bypass it.",
      looksAt: "Added lines in changed non-test TSX/JSX/Vue UI files where the same patch also adds i18n calls.",
      reports: "File and line only — never string content.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Inactive when the file's added lines show no t()/useTranslation/FormattedMessage-style convention. Skips technical props and dotted i18n-key-shaped literals.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### i18n regressions (hardcoded UI copy where translation is in use)"];
      for (const item of findings) {
        lines.push(`- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)}`);
      }
      return lines;
    },
    run: (req, { signal }) => scanI18nRegression(req, signal),
  }),
  descriptor({
    name: "unusedExport",
    title: "Unused exports (dead-on-arrival)",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: { maxSymbols: 10, maxSearches: 10, maxFindings: 25 },
    docs: {
      summary:
        "Flags exports newly added by the PR that have zero non-declaration references anywhere in the repo.",
      looksAt:
        "Direct `export const/let/var/function/class/interface/type/enum` declarations added in changed non-test TS/JS source files, cross-checked via repo-scoped GitHub Code Search.",
      reports: "File, line, and symbol name of each dead-on-arrival export — never file contents.",
      network:
        "One bounded GitHub Code Search query per candidate symbol (capped). Requires headSha and GitHub token forwarding for private repos.",
      notes:
        "Conservative: re-export lists and `export *` are ignored (same as undocumented-export). Skips symbols shorter than 3 chars. Checks same-file references in the headSha file before querying default-branch Code Search (where brand-new PR exports are usually absent). Fail-safe on search errors or incomplete results.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Unused exports (new export with no references in the repo)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} exports ${helpers.safeCodeSpan(item.symbol)} with no references found`,
        );
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanUnusedExport(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "exhaustiveness",
    title: "Enum/union exhaustiveness drift",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["files", "github-token", "head-sha"],
    limits: { maxFiles: 10, maxFetches: 10, maxFindings: 25 },
    docs: {
      summary:
        "Flags when a PR adds a new enum member or string-literal union variant but an exhaustive switch still omits it.",
      looksAt:
        "Added enum/union members in changed TS/JS files, comparing pre-PR vs headSha member sets and scanning changed files for switches that covered all old members.",
      reports: "Type file, line, union/enum name, added member, and optional consumer file — never file contents.",
      network:
        "Bounded GitHub contents fetches at headSha for changed source files. Requires GitHub token forwarding for private repos.",
      notes:
        "Conservative: only explicit enum/union case labels; switches with a default branch are skipped. Fail-safe on fetch errors or ambiguous type parsing.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Enum/union exhaustiveness drift (switch missing a newly added member)"];
      for (const item of findings) {
        const where = item.consumerFile
          ? `${helpers.safeCodeSpan(item.consumerFile)} switch`
          : helpers.safeCodeSpan(`${item.file}:${item.line}`);
        lines.push(
          `- ${where} omits ${helpers.safeCodeSpan(item.unionName)}.${helpers.safeCodeSpan(item.addedMember)} after it was added at ${helpers.safeCodeSpan(`${item.file}:${item.line}`)}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanExhaustivenessDrift(req, fetch, { signal }),
  }),
  descriptor({
    name: "flakyTest",
    title: "Flaky-test history",
    category: "history",
    cost: "github-heavy",
    defaultEnabled: true,
    requires: ["files", "github-token"],
    limits: {
      maxFilesProbed: 6,
      maxCommitsPerFile: 5,
      maxCheckRunFetches: 12,
      windowDays: 30,
      maxFindings: 25,
    },
    docs: {
      summary:
        "For test files this PR touches, surfaces recent default-branch CI test-check failures that reference each file.",
      looksAt:
        "Changed test paths, then bounded default-branch commits per file and their check-runs (structured output fields only).",
      reports: "Test file path, failure-event count, and lookback window — never check logs or output text.",
      network:
        "Calls GitHub repo, commits, and check-runs APIs with strict fanout caps. Requires GitHub token forwarding for private repos.",
      notes:
        "Conservative: only test-named checks whose output references the file; requires at least two failure events in the window. Emits partial status when the probe budget is exhausted.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = ["### Flaky-test history (recent CI test failures referencing changed tests)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(item.file)} — ${item.recentFailures} failure event${item.recentFailures === 1 ? "" : "s"} in the last ${helpers.safeCodeSpan(item.window)}`,
        );
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanFlakyTest(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "commitLint",
    title: "Conventional-commit subjects",
    category: "quality",
    cost: "github-light",
    defaultEnabled: true,
    requires: ["github-token"],
    limits: { maxCommits: 100, maxFindings: 25 },
    docs: {
      summary:
        "Lints the PR's commit subjects against the Conventional Commits spec and flags non-conforming subjects (bad/absent type, over-long, or empty).",
      looksAt: "The PR's commits (one bounded page) — each commit's message subject line.",
      reports: "A short commit-SHA prefix, the subject line, and the failing reason — never full diff/file content.",
      network: "Calls the GitHub PR-commits API once, bounded to one page.",
      notes:
        "Structured-fields-only: reads commit.message subjects, linted independently, never cross-line state. Fail-safe on missing token/fetch error.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const explain = (reason: (typeof findings)[number]["reason"]): string => {
        switch (reason) {
          case "empty":
            return "empty subject";
          case "too-long":
            return "subject exceeds 72 characters";
          case "missing-colon":
            return "not `type: summary` — missing the Conventional-Commit structure";
          case "bad-type":
            return "unrecognized commit type";
        }
      };
      const lines = ["### Non-conforming commit subjects (Conventional Commits)"];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(item.sha)} — ${explain(item.reason)}: ${helpers.promptText(item.subject)}`,
        );
      }
      return lines;
    },
    run: (req, { signal, analysis, diagnostics }) =>
      scanCommitLint(req, fetch, { signal, analysis, diagnostics }),
  }),
  descriptor({
    name: "apiBreak",
    title: "Breaking API change (removed/renamed export)",
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxEntrypoints: 25, maxFindings: 25 },
    docs: {
      summary:
        "Flags an exported symbol a PR removes or renames in a package public entrypoint — a semver-major break for downstream consumers shipped without a major version bump.",
      looksAt:
        "Removed (-) top-level export declarations and re-exports in changed public-entrypoint files (index/mod/main/public-api) whose name is not re-added anywhere in the same file's patch.",
      reports:
        "Public entrypoint file, old-file line, and the removed or renamed exported symbol name — never surrounding code.",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Conservative: only a top-level export whose exact name disappears from the file's public surface is reported; a same-name edit (signature or value change) or a non-entrypoint file is never flagged. Bounded by entrypoint and finding caps; fail-safe on absent or malformed patches.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = [
        "### Breaking API changes (exported symbol removed or renamed in a public entrypoint)",
      ];
      for (const item of findings) {
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.file}:${item.line}`)} — ${helpers.safeCodeSpan(item.symbol)} removed from the public surface`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanApiBreak(req, signal),
  }),
  descriptor({
    name: "deprecatedDep",
    title: "Deprecated / unmaintained dependency",
    category: "supply-chain",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    limits: { maxManifestFiles: 20, maxPatchLinesPerFile: 500, maxFindings: 25 },
    docs: {
      summary:
        "Flags a direct dependency a PR newly adds or upgrades that is an officially deprecated or unmaintained package with a maintained successor — an adoption risk the review brief should surface.",
      looksAt:
        "Added/changed dependency names in package.json and requirements.txt patches, matched against a bundled curated list of well-known deprecated packages.",
      reports:
        "Ecosystem, package, added version, direction (add/change), the documented deprecation reason, and the recommended replacement — never manifest contents.",
      network: "Pure local analyzer. No external network call; the curated list is bundled.",
      notes:
        "Conservative: only an exact match against the bundled list is flagged, so a package it does not name is never reported. Bounded by manifest, patch-line, and finding caps; fail-safe on absent patches or an aborted signal.",
    },
    render: (findings, helpers) => {
      if (!findings.length) return [];
      const lines = [
        "### Deprecated or unmaintained dependencies (newly added or upgraded)",
      ];
      for (const item of findings) {
        const replacement = item.replacement
          ? `; consider ${helpers.safeCodeSpan(item.replacement)}`
          : "";
        lines.push(
          `- ${helpers.safeCodeSpan(`${item.package}@${item.version}`)} (${helpers.safeCodeSpan(item.ecosystem)}) — ${helpers.promptText(item.reason)}${replacement}`,
        );
      }
      return lines;
    },
    run: (req, { signal }) => scanDeprecatedDependencies(req, signal),
  }),
] as const satisfies readonly AnyAnalyzerDescriptor[];

export const ANALYZER_NAMES = ANALYZER_DESCRIPTORS.map(
  (analyzer) => analyzer.name,
) as AnalyzerName[];

export const ANALYZERS = Object.fromEntries(
  ANALYZER_DESCRIPTORS.map((analyzer) => [analyzer.name, analyzer.run]),
) as Record<AnalyzerName, AnalyzerFn>;

export const ANALYZER_REGISTRY: AnalyzerRegistry = ANALYZERS;

export const ANALYZER_DESCRIPTORS_BY_NAME = Object.fromEntries(
  ANALYZER_DESCRIPTORS.map((analyzer) => [analyzer.name, analyzer]),
) as Partial<Record<AnalyzerName, AnyAnalyzerDescriptor>>;

export function getAnalyzerDescriptor<Name extends AnalyzerName>(
  name: Name,
): AnalyzerDescriptor<Name> | undefined {
  return ANALYZER_DESCRIPTORS_BY_NAME[name] as
    | AnalyzerDescriptor<Name>
    | undefined;
}
