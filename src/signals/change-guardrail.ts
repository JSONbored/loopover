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
// on an adversarial near-miss input once MULTIPLE wildcard GROUPS chain in one glob (a "group" is one `*` OR
// one `**` — a `**` pair compiles to a SINGLE `.*`, not two independent wildcards, so it must be counted as ONE
// group, not two characters; see countWildcardGroups below). Both group types contribute to the same danger once
// chained. MAX_GLOB_WILDCARD_GROUPS = 2 is the highest compiled backtracking-group count empirically proven safe
// (benchmarked 2026-07-01: sub-second even at wildly implausible adversarial path lengths; 3+ groups reach
// multi-second hangs within a few thousand characters — see test/unit/change-guardrail.test.ts's SECURITY
// (ReDoS) cases for the exact numbers). The cap lives INSIDE globToRegExp itself (not just in a wrapper like
// matchesAny below) so every caller — present or future, direct or indirect, including
// content-lane/spec-resolver.ts's config-driven globs — is protected automatically. A caller with a STRICTER
// fail direction (e.g. matchesAny's fail-toward-guarding for a security guardrail) overrides at its own layer.
// Exported so any OTHER glob-safety check in this codebase (e.g. focus-manifest.ts's parse-time
// normalizeOptionalGlob, which rejects an over-complex contentLane.*Glob before it ever reaches globToRegExp)
// shares this exact threshold instead of drifting with its own re-derived number.
export const MAX_GLOB_WILDCARD_GROUPS = 2;

/** Count `*` GROUPS in `glob` — a `**` pair is ONE group (it compiles to a single `.*`, see globToRegExp), not
 *  two. Mirrors globToRegExp's own tokenization exactly (including consuming a `**`'s trailing `/`) so the count
 *  reflects the actual number of backtracking-capable groups the compiled RegExp will contain, not raw `*`
 *  character count (which would double-count every globstar and reject legitimate globs like
 *  "public/**\/*.json" — 2 real groups — as if they were 3-groups-dangerous). Exported for reuse by any other
 *  glob-safety check in this codebase — see MAX_GLOB_WILDCARD_GROUPS above. */
export function countWildcardGroups(glob: string): number {
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
 *  backtracking (see the MAX_GLOB_WILDCARD_GROUPS rationale above). */
function hasUnsafeWildcardCount(glob: string): boolean {
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
