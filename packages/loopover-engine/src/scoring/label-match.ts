import { hasUnsafeWildcardCount } from "../signals/change-guardrail.js";

export function labelMatchesPattern(label: string, pattern: string): boolean {
  return labelPatternToRegExp(pattern.toLowerCase()).test(label.toLowerCase());
}

// Compiled fnmatch→RegExp matchers are memoized by pattern. The same small,
// config-derived set of label keys is matched on every scored PR/issue, so the
// per-call recompile inside the nested label loops in engine.ts is pure waste.
// Keys come from a repo's registryConfig.labelMultipliers, sourced from the externally-fetched gittensor
// registry (registry/sync.ts + registry/normalize.ts, not a value this repo's own maintainer directly controls
// via .loopover.yml) — so the pattern SET is small per repo, but individual pattern CONTENT is untrusted, not
// literally attacker-supplied-per-request the way GitHub PR content is. The wildcard-count cap below (#2456)
// bounds a single pattern's compile cost; this cache is additionally bounded to a fixed max entry count and
// evicted LRU, so a long-running isolate that observes many distinct registry snapshots over its life still
// can't grow the cache unboundedly. The compiled RegExp carries only the "i" flag (no global/sticky `lastIndex`
// state), so sharing one instance across calls is safe and byte-identical to recompiling on every call.
export const LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES = 256;
const labelPatternRegExpCache = new Map<string, RegExp>();

// A RegExp that never matches any input — mirrors change-guardrail.ts's identical NEVER_MATCHES fallback for an
// over-complex pattern, so a pathological registry entry degrades to "this label multiplier never applies"
// instead of hanging the scoring path that evaluates it.
const LABEL_PATTERN_NEVER_MATCHES = /^(?!)$/;

// Upstream resolves label multipliers by matching each configured key as a Python `fnmatch` GLOB, not a
// literal string: `fnmatch(label.lower(), pattern.lower())` in
// gittensor/validator/oss_contributions/label_resolution.py, so a repo can configure `type:*`, `kind/*`, or
// `priority:?` and have it match `type:bug-fix`, `kind/bug`, `priority:1` (#1244-class scoring parity). The
// preview previously did exact equality, so it silently scored every wildcard-configured trusted label at the
// neutral default — under-/over-estimating the score for any repo using glob keys. Translate one fnmatch
// pattern to an anchored, case-insensitive RegExp. fnmatch semantics differ from the path-glob in
// change-guardrail.ts (there `*` stops at `/` and `?` is literal): labels are flat strings, so `*` matches any
// run, `?` any single character, and `[seq]`/`[!seq]` a character class. Literal keys are unaffected — for a
// pattern with no glob metacharacter the RegExp is an exact match, so existing configs score identically.
export function labelPatternToRegExp(pattern: string): RegExp {
  const cached = labelPatternRegExpCache.get(pattern);
  if (cached !== undefined) {
    // Refresh recency on hit so the cache behaves as an LRU: the most-recently-matched patterns
    // survive eviction, not just the most-recently-inserted ones.
    labelPatternRegExpCache.delete(pattern);
    labelPatternRegExpCache.set(pattern, cached);
    return cached;
  }
  // Reuses change-guardrail.ts's wildcard-GROUP counting (a `*` here matches the same "any run of chars"
  // semantics as that glob compiler's `*`, so the same catastrophic-backtracking risk and the same empirically-
  // safe threshold apply) — an over-complex registry-sourced label_multipliers key degrades to a safe never-match
  // instead of hanging RegExp.test() on an adversarial near-miss label (#2456). Reachable via the public
  // score-preview API, the MCP tool, and the per-PR label-audit signal, so one bad registry entry could otherwise
  // hang scoring for every PR on that repo.
  if (hasUnsafeWildcardCount(pattern)) {
    setLabelPatternRegExpCacheEntry(pattern, LABEL_PATTERN_NEVER_MATCHES);
    return LABEL_PATTERN_NEVER_MATCHES;
  }
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    i += 1;
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        // No closing bracket: fnmatch treats the `[` as a literal character.
        regex += "\\[";
      } else {
        const rawBody = pattern.slice(i, close);
        if (rawBody === "" || rawBody === "!") {
          // Empty classes and bare `[!]` stay literal in Python fnmatch instead of compiling as classes.
          regex += `\\[${escapeRegExpLiteral(rawBody)}\\]`;
        } else if (hasDescendingCharacterRange(rawBody)) {
          // Python fnmatch treats invalid ranges like `[z-a]` as a never-match pattern; RegExp throws.
          regex += "(?!)";
        } else {
          let body = rawBody.replace(/\\/g, "\\\\");
          // `[!seq]` is fnmatch's negated class; RegExp spells negation as `[^seq]`.
          if (body.startsWith("!")) body = `^${body.slice(1)}`;
          else if (body.startsWith("^")) body = `\\${body}`;
          regex += `[${body}]`;
        }
        i = close + 1;
      }
    } else if (/[.+^${}()|\]\\]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  const compiled = new RegExp(`^${regex}$`, "i");
  setLabelPatternRegExpCacheEntry(pattern, compiled);
  return compiled;
}

// Inserts a new (never-before-cached) entry, evicting the least-recently-used entry first if the
// cache is already at its bound. Callers must only use this for keys not already present — refreshing
// an existing key's recency on a cache hit is handled inline above via delete+set.
function setLabelPatternRegExpCacheEntry(pattern: string, compiled: RegExp): void {
  if (labelPatternRegExpCache.size >= LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES) {
    // Map iteration order is insertion order, so the first key is always the least-recently-used
    // one (recency is refreshed via delete+set on every hit/insert). The map is non-empty here
    // because size >= LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES (a positive constant), so the loop body
    // always runs exactly once.
    for (const oldestPattern of labelPatternRegExpCache.keys()) {
      labelPatternRegExpCache.delete(oldestPattern);
      break;
    }
  }
  labelPatternRegExpCache.set(pattern, compiled);
}

export function clearLabelPatternRegExpCacheForTest(): void {
  labelPatternRegExpCache.clear();
}

export function labelPatternRegExpCacheKeysForTest(): string[] {
  return [...labelPatternRegExpCache.keys()];
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDescendingCharacterRange(body: string): boolean {
  const start = body.startsWith("!") ? 1 : 0;
  // Walk the class left-to-right, consuming each `X-Y` range as a unit so a range endpoint can't be
  // misread as the start of a spurious second range. Only a genuinely inverted range like `[z-a]` — the
  // case JS `RegExp` actually throws on — must degrade the class to never-match; a literal `-` that
  // follows a completed range (as in `[a-z-9]`, a valid class) must NOT be suppressed. The prior scan
  // flagged any `-` whose left neighbor outranked its right neighbor, so it wrongly killed `[a-z-9]`.
  let i = start;
  while (i < body.length) {
    if (i + 2 < body.length && body.charAt(i + 1) === "-") {
      if (body.charCodeAt(i) > body.charCodeAt(i + 2)) return true;
      i += 3;
    } else {
      i += 1;
    }
  }
  return false;
}

