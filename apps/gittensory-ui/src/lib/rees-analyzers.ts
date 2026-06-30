export type ReesAnalyzerDoc = {
  name: string;
  title: string;
  summary: string;
  looksAt: string;
  reports: string;
  network: string;
  notes: string;
};

export const REES_ANALYZERS: ReesAnalyzerDoc[] = [
  {
    name: "dependency",
    title: "Dependency vulnerabilities",
    summary: "Checks changed direct dependency versions against OSV.dev.",
    looksAt: "Added or upgraded dependencies in package.json, requirements.txt, and go.mod diffs.",
    reports:
      "Known CVEs with severity, advisory id, summary, and fixed version when OSV publishes one.",
    network: "Calls OSV.dev. No GitHub token required.",
    notes: "Manifest-only by design; use lockfileDrift for transitive lockfile changes.",
  },
  {
    name: "lockfileDrift",
    title: "Lockfile drift",
    summary:
      "Finds vulnerable transitive dependency versions introduced only through lockfile changes.",
    looksAt:
      "package-lock.json, yarn.lock, and poetry.lock patches, excluding packages already named in a changed manifest.",
    reports: "Lockfile line, package/version, ecosystem, direction, and OSV vulnerability details.",
    network: "Calls OSV.dev querybatch. No GitHub token required.",
    notes:
      "Useful when a PR does not touch a top-level manifest but changes resolved dependency pins.",
  },
  {
    name: "secret",
    title: "Hardcoded secrets",
    summary: "Scans added diff lines for credential-shaped values.",
    looksAt: "Added lines in every changed file patch.",
    reports: "File, line, secret kind, and confidence. The matched value is never returned.",
    network: "Pure local analyzer. No external network call.",
    notes:
      "High-confidence patterns are treated as rotate-and-remove candidates; generic assignments stay verify-first.",
  },
  {
    name: "license",
    title: "Dependency licenses",
    summary: "Checks licenses for newly added or upgraded dependencies.",
    looksAt: "The same direct dependency changes used by the dependency analyzer.",
    reports:
      "Copyleft or unknown license classifications that need maintainer compatibility review.",
    network: "Calls deps.dev. No GitHub token required.",
    notes: "Permissive and otherwise-known licenses are intentionally silent.",
  },
  {
    name: "installScript",
    title: "npm install scripts",
    summary: "Flags npm packages that run lifecycle hooks during install.",
    looksAt: "New or upgraded npm dependencies.",
    reports: "Package, version, hook names, and publish date when available.",
    network: "Calls the npm registry. No GitHub token required.",
    notes: "The script body is not returned, which keeps the brief compact and non-executable.",
  },
  {
    name: "actionPin",
    title: "Unpinned GitHub Actions",
    summary: "Detects third-party workflow actions pinned to mutable tags or branches.",
    looksAt: "Added uses: lines in .github/workflows YAML patches.",
    reports: "Workflow file, line, action, and mutable ref.",
    network: "Pure local analyzer. No external network call.",
    notes: "Official actions/* and github/* actions are excluded to keep the signal focused.",
  },
  {
    name: "eol",
    title: "End-of-life runtimes",
    summary: "Checks changed runtime and base-image pins against EOL calendars.",
    looksAt: "Dockerfile FROM lines, .nvmrc, and go.mod runtime pins.",
    reports:
      "File, product, version, EOL date, and whether the release is already EOL or close to EOL.",
    network: "Calls endoflife.date. No GitHub token required.",
    notes: "Only changed pins are checked; existing old runtimes outside the PR are not reported.",
  },
  {
    name: "redos",
    title: "ReDoS-prone regex",
    summary: "Finds newly introduced regex shapes that can catastrophically backtrack.",
    looksAt: "Regex literals and RegExp constructor string arguments in added lines.",
    reports: "File, line, and a truncated vulnerable pattern.",
    network: "Pure local analyzer. No external network call.",
    notes:
      "Structural and precision-first; it flags nested unbounded quantifier shapes such as (a+)+.",
  },
  {
    name: "provenance",
    title: "Provenance and committed artifacts",
    summary: "Checks package attestations and reviewability of newly added artifacts.",
    looksAt: "New npm/PyPI dependency versions plus added binary, vendored, and minified files.",
    reports:
      "Missing attestations, binary files without reviewable source, and vendored or minified code.",
    network:
      "Calls npm and PyPI attestation/provenance endpoints for package checks. Path checks are local.",
    notes: "Network failures fail safe; it flags only confident no-attestation responses.",
  },
  {
    name: "codeowners",
    title: "CODEOWNERS coverage",
    summary: "Checks whether changed files cross ownership domains not owned by the PR author.",
    looksAt: ".github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS plus the changed file list.",
    reports:
      "Owned files where the PR author is not listed, plus ownership blast-radius context in the rendered brief.",
    network:
      "Calls the GitHub API. Requires author plus GitHub token forwarding for private repos.",
    notes:
      "Leave REES_FORWARD_GITHUB_TOKEN unset/false to disable token forwarding; this analyzer will then skip when it cannot read CODEOWNERS.",
  },
  {
    name: "secretLog",
    title: "Secrets or PII in logs",
    summary: "Flags added code that writes sensitive values to logs or stdout.",
    looksAt: "Added lines that call console, logger, process.stdout, or process.stderr sinks.",
    reports: "File, line, sink, and category: secret, pii, or request-object.",
    network: "Pure local analyzer. No external network call.",
    notes:
      "String log messages are stripped before matching, so ordinary prose like password reset is not enough to trigger.",
  },
  {
    name: "assetWeight",
    title: "Heavy binary assets",
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
  {
    name: "typosquat",
    title: "Typosquat and dependency-confusion risk",
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
];

export const REES_ANALYZER_NAMES = REES_ANALYZERS.map((analyzer) => analyzer.name);
