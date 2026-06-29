import { scanActionPins } from "./actions-pin.js";
import { scanAssetWeight } from "./asset-weight.js";
import { scanCodeowners } from "./codeowners.js";
import { scanCommitSignature } from "./commit-signature.js";
import { dependencyAnalyzer } from "./dependency/descriptor.js";
import { scanDocCommentDrift } from "./doc-comment-drift.js";
import { scanEol } from "./eol-check.js";
import { scanHeavyDependencies } from "./heavy-dependency.js";
import { scanHistory } from "./history.js";
import { scanIacMisconfig } from "./iac-misconfig.js";
import { scanInstallScripts } from "./install-scripts.js";
import { scanLicenses } from "./license-check.js";
import { scanLockfileDrift } from "./lockfile-drift.js";
import { scanNativeBuild } from "./native-build.js";
import { scanProvenance } from "./provenance.js";
import { scanRedos } from "./redos.js";
import { secretAnalyzer } from "./secret/descriptor.js";
import { scanSecretLog } from "./secret-log.js";
import { scanTyposquat } from "./typosquat.js";
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
    run: (req, { signal }) => scanLockfileDrift(req, fetch, { signal }),
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
    run: (req) => scanLicenses(req),
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
    run: (req) => scanInstallScripts(req),
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
    run: (req, { signal }) => scanHeavyDependencies(req, fetch, { signal }),
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
      looksAt: "Dockerfile FROM lines, .nvmrc, and go.mod runtime pins.",
      reports:
        "File, product, version, EOL date, and whether the release is already EOL or close to EOL.",
      network: "Calls endoflife.date. No GitHub token required.",
      notes: "Only changed pins are checked; existing old runtimes outside the PR are not reported.",
    },
    run: (req) => scanEol(req),
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
    run: (req, { signal }) => scanProvenance(req, fetch, { signal }),
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
    run: (req, { signal }) => scanCodeowners(req, fetch, { signal }),
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
    run: (req, { signal }) => scanAssetWeight(req, fetch, { signal }),
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
    run: (req, { signal }) => scanTyposquat(req, fetch, { signal }),
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
    run: (req, { signal }) => scanCommitSignature(req, fetch, { signal }),
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
    run: (req, { signal }) => scanNativeBuild(req, fetch, { signal }),
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
