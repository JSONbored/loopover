// Typosquat + dependency-confusion analyzer (#1501). For each dependency a PR newly ADDS, flags two supply-chain
// risks the no-checkout `claude --print` reviewer cannot: (1) a name that is a near-miss of a popular package
// (edit-distance / homoglyph / separator / scope-swap) — a likely typosquat; (2) an unscoped name that is NOT
// published on the public registry and is therefore publicly claimable — a dependency-confusion vector. Pure
// name analysis runs offline against a bundled popular-package list; the confusion check uses an injected fetch.
import type { EnrichRequest, TyposquatFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_DEPS = 50;
const MAX_CONFUSION_QUERIES = 15;
// Short names have too many distance-1 neighbours to flag reliably; require some length before an edit-distance hit.
const MIN_LEN_DISTANCE_1 = 4;

interface ScanLimits {
  maxDeps?: number;
  maxConfusionQueries?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

// Bundled top popular packages per ecosystem — the high-traffic names typosquatters impersonate. Not exhaustive;
// the near-miss compare only needs the most-squatted targets. Lowercased. An exact match here is the REAL package.
const POPULAR: Record<string, readonly string[]> = {
  npm: [
    "react", "react-dom", "lodash", "express", "axios", "chalk", "commander", "request", "async", "debug",
    "moment", "vue", "webpack", "typescript", "jest", "eslint", "prettier", "dotenv", "uuid", "classnames",
    "next", "tailwindcss", "redux", "rxjs", "mongoose", "bcrypt", "jsonwebtoken", "cors", "body-parser",
    "node-fetch", "yargs", "glob", "semver", "minimist", "colors", "underscore", "bluebird", "fs-extra", "ws",
  ],
  PyPI: [
    "requests", "numpy", "pandas", "flask", "django", "setuptools", "urllib3", "boto3", "scipy", "pytest",
    "pillow", "six", "click", "pyyaml", "cryptography", "jinja2", "sqlalchemy", "beautifulsoup4", "matplotlib",
    "torch", "scikit-learn", "certifi", "idna", "wheel", "python-dateutil", "tqdm", "aiohttp", "fastapi", "pydantic",
  ],
};

// Well-known legitimate packages that sit a near-miss away from a popular name but are NOT typosquats — exempt
// from all name flagging so they don't false-positive (e.g. `preact` is one edit from `react`). Extensible.
const KNOWN_LEGIT: Record<string, readonly string[]> = {
  npm: ["preact", "lodash-es", "vuex", "react-router", "react-scripts", "babel-jest"],
  PyPI: ["requests-oauthlib", "djangorestframework", "pytest-django"],
};

const REGISTRY_URL: Record<string, (name: string) => string> = {
  npm: (name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  PyPI: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
};

/** Damerau-Levenshtein (optimal string alignment) distance — counts insert/delete/substitute + adjacent
 *  transposition. Bounded: returns `max + 1` as soon as the whole row exceeds `max`, so callers can early-reject. */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1);
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

const HOMOGLYPH: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "6": "b", "7": "t", "9": "g" };

/** Canonical form for confusable-name detection: lowercase, map digit homoglyphs to letters, and strip the
 *  interchangeable separators `-`, `_`, `.`. Two distinct raw names with the same canonical form differ only by a
 *  confusable substitution (e.g. `lodash` vs `l0dash`, `lo-dash`, `lo_dash`). Pure. */
export function canonicalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[013456789]/g, (d) => HOMOGLYPH[d] ?? d)
    .replace(/[-_.]/g, "");
}

/** Pure near-miss classifier for an UNSCOPED dependency name: is it a likely typosquat of a bundled popular
 *  `ecosystem` package? Returns the matched popular name + reason, or null.
 *
 *  SCOPED names (`@scope/x`) are deliberately never classified: an npm scope is namespace-protected (you cannot
 *  publish under `@types`/`@acme` without owning it), so a scoped package whose tail merely matches a popular
 *  name — `@types/react`, `@acme/express` — is not impersonation. Restricting to unscoped names removes that
 *  whole false-positive class while still covering the real typosquat surface (the public flat namespace).
 *
 *  Checks (in order): exact (safe → null), known-legit near-neighbour (safe → null), homoglyph/separator
 *  (canonical-form equal), then a distance-1 edit. */
export function classifyTyposquat(
  ecosystem: string,
  rawName: string,
): { similarTo: string; distance?: number; reason: string } | null {
  const popular = POPULAR[ecosystem];
  if (!popular) return null;
  if (rawName.startsWith("@")) return null; // scoped names are namespace-protected — not a typosquat surface
  const name = rawName.toLowerCase();
  if (popular.includes(name)) return null; // it IS the popular package
  if (KNOWN_LEGIT[ecosystem]?.includes(name)) return null; // a known-legitimate near-neighbour, not a squat

  const canon = canonicalize(name);
  for (const target of popular) {
    if (name === target) continue;
    if (canonicalize(target) === canon) {
      return { similarTo: target, distance: 0, reason: `homoglyph/separator variant of '${target}'` };
    }
  }

  let best: { target: string; distance: number } | null = null;
  for (const target of popular) {
    if (Math.min(name.length, target.length) < MIN_LEN_DISTANCE_1) continue;
    if (damerauLevenshtein(name, target, 1) === 1 && !best) best = { target, distance: 1 };
  }
  if (best) {
    return { similarTo: best.target, distance: best.distance, reason: `edit distance ${best.distance} from '${best.target}'` };
  }
  return null;
}

/** Is `name` published on the public registry for `ecosystem`? `true`/`false` on a definitive 200/404, or `null`
 *  when undeterminable (unsupported ecosystem, network error, or any non-200/404 status) — callers fail safe on null. */
export async function isPublished(
  ecosystem: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const toUrl = REGISTRY_URL[ecosystem];
  if (!toUrl || signal?.aborted) return null;
  try {
    const response = await fetchImpl(toUrl(name), { signal });
    if (response.status === 404) return false;
    if (response.ok) return true;
    return null;
  } catch {
    return null;
  }
}

/** Analyzer entrypoint: newly-added deps → typosquat near-miss (pure) + dependency-confusion (registry 404). */
export async function scanTyposquat(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<TyposquatFinding[]> {
  const maxDeps = options.limits?.maxDeps ?? MAX_DEPS;
  const maxConfusion = options.limits?.maxConfusionQueries ?? MAX_CONFUSION_QUERIES;
  // Only names the PR INTRODUCES (from === null) carry name-novelty risk; a version bump keeps an existing name.
  const added = extractDependencyChanges(req.files ?? [])
    .filter((change) => change.from === null)
    .slice(0, maxDeps);

  const findings: TyposquatFinding[] = [];
  let confusionQueries = 0;
  for (const dep of added) {
    if (options.signal?.aborted) break;
    const match = classifyTyposquat(dep.ecosystem, dep.package);
    if (match) {
      findings.push({
        ecosystem: dep.ecosystem,
        package: dep.package,
        version: dep.to,
        kind: "typosquat",
        similarTo: match.similarTo,
        ...(match.distance !== undefined ? { distance: match.distance } : {}),
        reason: match.reason,
      });
      continue;
    }
    // Dependency-confusion: an UNSCOPED name (scoped names are namespace-protected) absent from the public
    // registry is publicly claimable. Only a definitive 404 flags it; transient/unknown states fail safe.
    const isScoped = dep.package.startsWith("@");
    if (!isScoped && confusionQueries < maxConfusion && REGISTRY_URL[dep.ecosystem]) {
      confusionQueries += 1;
      const published = await isPublished(dep.ecosystem, dep.package, fetchImpl, options.signal);
      if (published === false) {
        findings.push({
          ecosystem: dep.ecosystem,
          package: dep.package,
          version: dep.to,
          kind: "confusion",
          reason: `not published on the public ${dep.ecosystem} registry — an unscoped name that is publicly claimable (dependency-confusion)`,
        });
      }
    }
  }
  return findings;
}
