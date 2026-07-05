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
import { scanDocCommentDrift } from "./doc-comment-drift.js";
import { scanDuplication } from "./duplication-scan.js";
import { scanEol } from "./eol-check.js";
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
import { scanTerminology } from "./terminology.js";
import { scanTodoMarker } from "./todo-marker.js";
import { scanTyposquat } from "./typosquat.js";
import { scanUndocumentedExport } from "./undocumented-export.js";
import { scanWorkflowInjection } from "./workflow-injection.js";
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
    name: "workflowInjection",
    title: "Workflow-injection / pwn-request risk",
    category: "security",
    cost: "local",
    defaultEnabled: true,
    requires: ["files"],
    docs: {
      summary:
        "Detects GitHub Actions pwn-request risk: a pull_request_target/workflow_run workflow that runs elevated CI against attacker-controlled input.",
      looksAt:
        "Added/context lines in .github/workflows YAML patches: the trigger, an untrusted-ref checkout, run: steps that interpolate event fields, and the top-level permissions block.",
      reports: "Workflow file, line, and rule kind (untrusted checkout, unsafe interpolation, or missing permissions).",
      network: "Pure local analyzer. No external network call.",
      notes:
        "Diff-only and file-scoped: an environment/permissions gate already present outside the diff's visible context is not seen, and job/step correlation is not performed. Never flags a plain pull_request trigger.",
    },
    run: (req) => scanWorkflowInjection(req),
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
