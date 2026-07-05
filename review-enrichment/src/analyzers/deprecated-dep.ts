// Deprecated / unmaintained direct-dependency analyzer (#1511, part of #1499). A no-checkout headless reviewer sees
// only the diff, so it cannot tell that a dependency a PR newly ADDS or UPGRADES is an officially deprecated or
// abandoned package that a maintained successor has replaced — an adoption risk + future supply-chain liability the
// review brief should surface. This fills that gap purely from the changed manifest patches: it reuses the shared
// manifest dependency-change parser and matches each added/upgraded package name against a BUNDLED, curated list of
// well-known deprecated packages per ecosystem — the same offline-list approach the typosquat analyzer uses for its
// popular-package set. Deterministic, no network, no token: the curated list is the sole source of truth, so a
// package it does not name is never flagged (conservative + fail-safe). Reports ecosystem, package, the added
// version, the change direction, the documented reason, and the recommended replacement — never manifest contents.
import type { DeprecatedDependencyFinding, EnrichRequest } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_MANIFEST_FILES = 20; // bound manifest files parsed per PR
const MAX_PATCH_LINES_PER_FILE = 500; // bound patch lines parsed per manifest
const MAX_FINDINGS = 25; // keep the brief bounded

interface DeprecationNote {
  reason: string;
  replacement: string | null;
}

// Curated, conservative registry of packages with a WELL-KNOWN published deprecation (npm-deprecated, a PyPI
// deprecation stub, or an officially retired project) and a maintained successor. Keyed ecosystem → normalized
// package name → note. Not exhaustive by design: only unambiguous, widely-recognized cases so a match is a real
// signal and never a guess. `replacement` is the community-recommended successor, or null when none is standard.
const DEPRECATED: Record<string, Record<string, DeprecationNote>> = {
  npm: {
    request: { reason: "deprecated — no longer maintained since 2020", replacement: "got or axios" },
    "request-promise": { reason: "deprecated with request", replacement: "got" },
    "request-promise-native": { reason: "deprecated with request", replacement: "got" },
    "node-sass": { reason: "deprecated — LibSass is deprecated", replacement: "sass (Dart Sass)" },
    tslint: { reason: "deprecated in favor of ESLint (2019)", replacement: "eslint + typescript-eslint" },
    "gulp-util": { reason: "deprecated — the bundled utility set was unpublished", replacement: null },
    istanbul: { reason: "deprecated — the project was renamed", replacement: "nyc" },
    "babel-preset-es2015": { reason: "deprecated — legacy Babel 6 preset", replacement: "@babel/preset-env" },
    bower: { reason: "deprecated front-end package manager", replacement: "npm or yarn" },
    "phantomjs-prebuilt": { reason: "deprecated — PhantomJS is suspended", replacement: "puppeteer or playwright" },
  },
  PyPI: {
    sklearn: { reason: "deprecated PyPI stub for scikit-learn", replacement: "scikit-learn" },
    nose: { reason: "unmaintained — no Python 3.10+ support", replacement: "pytest or nose2" },
    pycrypto: { reason: "unmaintained — known unpatched CVEs", replacement: "pycryptodome" },
    beautifulsoup: { reason: "legacy BeautifulSoup 3, no longer maintained", replacement: "beautifulsoup4" },
    distribute: { reason: "deprecated — merged back into setuptools", replacement: "setuptools" },
  },
};

/** Registry lookup key for a package name. npm names are case-folded; PyPI applies PEP 503 normalization —
 *  lowercased, with runs of `-`, `_`, and `.` collapsed to a single `-` — so `Foo_Bar` and `foo.bar` resolve
 *  to the same project. Pure. */
export function normalizeName(ecosystem: string, name: string): string {
  const lower = name.toLowerCase();
  return ecosystem === "PyPI" ? lower.replace(/[-_.]+/g, "-") : lower;
}

/** Flag each newly-added or upgraded direct dependency the curated list marks deprecated/unmaintained. Reuses the
 *  shared manifest parser (which only yields deps present after the change), so removals are never flagged.
 *  Deterministic, no network. Returns [] on an aborted signal or when no changed manifest names a listed package;
 *  bounded by the manifest, patch-line, and finding caps. */
export async function scanDeprecatedDependencies(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<DeprecatedDependencyFinding[]> {
  if (signal?.aborted) return [];
  const findings: DeprecatedDependencyFinding[] = [];
  const changes = extractDependencyChanges(req.files ?? [], {
    maxManifestFiles: MAX_MANIFEST_FILES,
    maxPatchLinesPerFile: MAX_PATCH_LINES_PER_FILE,
  });
  for (const change of changes) {
    if (signal?.aborted) break;
    const note = DEPRECATED[change.ecosystem]?.[normalizeName(change.ecosystem, change.package)];
    if (!note) continue;
    findings.push({
      ecosystem: change.ecosystem,
      package: change.package,
      version: change.to,
      direction: change.from ? "change" : "add",
      replacement: note.replacement,
      reason: note.reason,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}
