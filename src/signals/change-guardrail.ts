// Convergence safety: the hard-guardrail path check for the auto-maintain layer (#778). Changed paths that
// match a repo's hardGuardrailGlobs force MANUAL review — gittensory must never auto-merge OR auto-close a PR
// that touches a guarded path (scoring / auth / CI workflows / policy scripts, etc.). Ported verbatim from
// reviewbot core/change-classifier.ts — the mechanism that prevents the awesome-claude #4196 incident class
// (a weakened policy script auto-merging because its path wasn't guarded). Pure + dependency-free.

// Canonicalize a path or glob so matching is case- and separator-insensitive: backslashes → `/`, drop a
// leading `./` or `/`, and case-fold. Mirrors signals/focus-manifest `normalizePathForMatch` — without it a
// guarded path is evaded with `.github/Workflows/` (capital W), a `./`-prefix, or a `\` separator, turning a
// mandatory human hold on CI/policy files into an auto-merge.
function canonicalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

// globToRegExp's COMPILATION is linear-time, but the COMPILED pattern's .test() can be polynomial-to-exponential
// time on an adversarial near-miss input when MULTIPLE wildcard GROUPS chain in one glob (a "group" is one `*`
// OR one `**` — a `**` pair compiles to a SINGLE `.*`, not two independent wildcards, so it must be counted as
// ONE group, not two characters; see countWildcardGroups below). Both group TYPES contribute to the same danger
// once chained — `[^/]*` groups separated by a literal that class doesn't exclude (e.g. "-", not "/") back-
// track ambiguously, and `.*` groups back-track ambiguously EVEN when "/"-separated, since `.*` crosses `/`
// freely. Re-benchmarked against `path` lengths GitHub can plausibly deliver via a deeply nested file path in a
// malicious PR (both `path` and, via `.gittensory.yml`'s contentLane.*Glob fields, the glob itself can be
// attacker-influenced in the same PR):
//   2 wildcard groups (any mix of `*`/`**`, any arrangement): sub-second even at a wildly implausible 32,000-
//                       char adversarial path (worst case observed: ~400ms) — quadratic, bounded, never a
//                       realistic hang.
//   3 wildcard groups: OVER 2 SECONDS at just ~4,000 chars for one chained-`*` shape, over 100ms at ~1,600
//                       chars for a chained-`**` shape — already dangerous well within a plausible path length.
//   4+ wildcard groups: confirmed catastrophic — 35 SECONDS at just 1,614 chars for 4 chained `**` groups.
// hardGuardrailGlobs today are 100% hardcoded engine constants (see review/guardrail-config.ts) — no
// maintainer/contributor input reaches globToRegExp via that path today, and none of those real globs exceed 1
// wildcard group — but it is also exported for reuse by other maintainer-config-driven consumers
// (content-lane/spec-resolver.ts, whose real globs like "public/**/*.json" are exactly 2 groups: this cap must
// stay inclusive of that legitimate shape, not just "safer than before"), so the cap lives INSIDE globToRegExp
// itself (not just in a wrapper like matchesAny below) — every caller, present or future, direct or indirect, is
// protected automatically rather than needing to separately remember the risk. The boundary is set at the
// highest GROUP count proven safe by the benchmark above (2) — a boundary that itself sits inside the
// empirically dangerous range would defeat the point of a cap.
const MAX_GLOB_WILDCARD_GROUPS = 2;

/** Count `*` GROUPS in `glob` — a `**` pair is ONE group (it compiles to a single `.*`, see globToRegExp), not
 *  two. Mirrors globToRegExp's own tokenization exactly (including consuming a `**`'s trailing `/`) so the count
 *  reflects the actual number of backtracking-capable groups the compiled RegExp will contain, not raw `*`
 *  character count (which would double-count every globstar and reject legitimate globs like
 *  "public/**\/*.json" — 2 real groups — as if they were 3-groups-dangerous). */
function countWildcardGroups(glob: string): number {
  let count = 0;
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.charAt(i) !== "*") continue;
    count += 1;
    if (glob.charAt(i + 1) === "*") {
      i += 1; // consume the second star of the "**" pair — one group, not two
      if (glob.charAt(i + 1) === "/") i += 1; // `**/` also matches zero segments, mirroring globToRegExp
    }
  }
  return count;
}

/** True if `glob` has more wildcard GROUPS than can be safely compiled to a RegExp without risking catastrophic
 *  backtracking (see the MAX_GLOB_WILDCARD_GROUPS rationale above). Exported so any OTHER glob-accepting config
 *  surface (e.g. focus-manifest.ts's contentLane.*Glob parsing) can reject an over-complex glob using the SAME
 *  predicate globToRegExp itself enforces — a caller with its own, independently-counted threshold could accept
 *  a glob globToRegExp then silently compiles to NEVER_MATCHES, configuring a lane that can never activate. */
export function hasUnsafeWildcardCount(glob: string): boolean {
  return countWildcardGroups(glob) > MAX_GLOB_WILDCARD_GROUPS;
}

// A RegExp that never matches any input, at any position — the safe, conservative compiled form of an
// over-complex glob. "Never matches" (not "matches everything") is the correct default HERE because
// globToRegExp has no context on caller intent, and a false "matches everything" would be actively wrong for a
// non-guardrail caller (e.g. content-lane file-scope matching, where "matches everything" would misclassify
// every changed file as a registry submission). A caller whose OWN semantics want the opposite fail direction
// (a security guardrail, where under-protection is worse than an unnecessary hold) checks hasUnsafeWildcardCount
// itself and overrides — see matchesAny below.
const NEVER_MATCHES = /^(?!)$/;

/** Convert a path glob (`*` matches within a segment, `**` matches across `/`) to an anchored RegExp. The
 *  glob is canonicalized first, so matching is case-insensitive against a canonicalized path. Exported for
 *  reuse anywhere a maintainer-supplied path pattern needs compiling — never compile a raw regex string from
 *  config (ReDoS risk); this linear-time glob compiler is the one safe path pattern this codebase uses.
 *
 *  An over-complex glob (see MAX_GLOB_WILDCARD_GROUPS) short-circuits to NEVER_MATCHES instead of being compiled —
 *  this function never returns a RegExp that risks catastrophic backtracking on .test(), for any input. */
export function globToRegExp(glob: string): RegExp {
  if (hasUnsafeWildcardCount(glob)) return NEVER_MATCHES;
  const canonical = canonicalize(glob);
  let re = "";
  for (let i = 0; i < canonical.length; i += 1) {
    const c = canonical.charAt(i);
    if (c === "*") {
      if (canonical.charAt(i + 1) === "*") {
        re += ".*";
        i += 1;
        if (canonical.charAt(i + 1) === "/") i += 1; // `**/` also matches zero segments
      } else {
        re += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * True if `path` matches any of the globs (`*` within a segment, `**` across `/`), case-insensitively. A glob
 * with more wildcards than can be safely compiled (see hasUnsafeWildcardCount) is treated as matching EVERY
 * path — fail SAFE TOWARD GUARDING, mirroring isGuardrailHit's own "unknown ⇒ treat as a hit" philosophy (an
 * over-complex guardrail glob still forces manual review) rather than the NEVER_MATCHES default globToRegExp
 * itself falls back to, which would silently disable the maintainer's intended protection — the worse failure
 * mode for a safety guardrail specifically (see globToRegExp's own docstring for why NEVER_MATCHES is still the
 * right default for globToRegExp as a general-purpose compiler).
 */
export function matchesAny(path: string, globs: string[]): boolean {
  const canonicalPath = canonicalize(path);
  return globs.some((g) => hasUnsafeWildcardCount(g) || globToRegExp(g).test(canonicalPath));
}

/**
 * The changed paths (if any) that trip a hard guardrail. A non-empty result means the PR touches a guarded
 * path and MUST fall through to a human — gittensory may neither auto-merge nor auto-close it. Pure.
 */
export function changedPathsHittingGuardrail(changedPaths: string[], hardGuardrailGlobs: string[]): string[] {
  if (hardGuardrailGlobs.length === 0) return [];
  return changedPaths.filter((path) => path.length > 0 && matchesAny(path, hardGuardrailGlobs));
}

/**
 * Whether a PR's diff trips a hard guardrail — the BOOLEAN form shared by the disposition (held for owner
 * review) and the public comment (so the headline reads "held", not "safe to merge"). FAIL-SAFE on unknown
 * paths (#1062): when guardrails ARE configured but the changed-file set is empty (the cache is not yet / no
 * longer populated), we cannot prove the PR avoids a guarded path, so treat it as a hit. No guardrails
 * configured ⇒ never a hit. Pure.
 */
export function isGuardrailHit(changedPaths: string[], hardGuardrailGlobs: string[]): boolean {
  if (hardGuardrailGlobs.length === 0) return false;
  return changedPaths.length === 0 || changedPathsHittingGuardrail(changedPaths, hardGuardrailGlobs).length > 0;
}
