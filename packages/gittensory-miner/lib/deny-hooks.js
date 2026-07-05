// PreToolUse-style deny-hook primitives (#2295). A pure, deterministic rule evaluator modeled on Claude Code's
// PreToolUse deny-hook shape: given a proposed tool call and a set of deny rules, it decides allow/block WITHOUT
// executing, intercepting, or mutating anything. There is NO live tool-call interception in this phase — a later
// phase's real coding-agent driver plugs an event source into `evaluateDenyHooks`; this module is only the
// decision function. No IO, no globals, no Date/random: identical inputs always yield the identical verdict.
//
// A rule fires when its tool-name `matcher` matches AND every constraint it declares also matches:
//   - `pathPattern` (a glob) must match some path-shaped string in the tool-call input, and/or
//   - `inputIncludesAll` (substrings) must ALL appear in a single string-shaped input field (e.g. a command), and/or
//   - `inputTokenPattern` (a RegExp) must match a whole whitespace-separated token (quotes stripped) of a single
//     string-shaped input field — for flag-shaped needles like `-f`, where a substring test would also fire on
//     `--follow-tags`.
// A rule with none of these constraints fires on the matcher alone. The built-in DEFAULT_DENY_RULES mirror the
// forbidden-path patterns enforced in `scripts/check-mcp-package.mjs` plus a conservative git force-push guard.

/**
 * Compile a glob to an anchored, case-insensitive RegExp. `**` matches across path segments (any char incl.
 * `/`); a leading `**​/` also matches zero directories; `*` matches within a single segment (no `/`); every
 * other char is literal. Inputs are normalized before matching so `./`, nested, and Windows-style variants
 * cannot bypass the built-in path rules.
 */
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?"; // '**/' — any (or zero) leading directories
        } else {
          source += ".*"; // '**' — any char, including '/'
        }
      } else {
        source += "[^/]*"; // '*' — any char except '/'
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function normalizePathCandidate(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/\.\//g, "/")
    .replace(/\/+$/, "");
}

/** Collect string values anywhere in a tool-call input so rules can test nested tool arguments without
 *  hard-coding field names. Non-object input yields no strings (rule can't match). */
function collectInputStrings(input, seen = new WeakSet()) {
  const strings = [];
  if (!input || typeof input !== "object") return strings;
  if (seen.has(input)) return strings;
  seen.add(input);
  const values = Array.isArray(input) ? input : Object.values(input);
  for (const value of values) {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") strings.push(...collectInputStrings(value, seen));
  }
  return strings;
}

/** Split a string-shaped input field into whitespace-separated tokens with surrounding quotes stripped —
 *  shared by path-candidate expansion and flag-token matching below. */
function splitTokens(value) {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);
}

/**
 * The candidate strings a path glob is tested against for one input value: the whole value AND each
 * whitespace-separated token (surrounding quotes stripped). A protected path is frequently embedded as one
 * argument of a command-shaped string (`git add .github/workflows/ci.yml`), so the evaluator tokenizes here
 * rather than relying on a later caller to split the command first — a bare path-valued field still matches via
 * the whole-value candidate.
 */
function pathCandidates(value) {
  const candidates = new Set([value, normalizePathCandidate(value)]);
  for (const trimmed of splitTokens(value)) {
    candidates.add(trimmed);
    candidates.add(normalizePathCandidate(trimmed));
  }
  return [...candidates].filter(Boolean);
}

function matcherMatches(matcher, toolName) {
  if (typeof matcher !== "string") return false;
  return globToRegExp(matcher).test(typeof toolName === "string" ? toolName : "");
}

function ruleMatches(rule, toolName, inputStrings) {
  if (!rule || typeof rule !== "object") return false;
  if (!matcherMatches(rule.matcher, toolName)) return false;
  if (typeof rule.pathPattern === "string") {
    const pattern = globToRegExp(rule.pathPattern);
    if (!inputStrings.some((value) => pathCandidates(value).some((candidate) => pattern.test(candidate)))) {
      return false;
    }
  }
  if (Array.isArray(rule.inputIncludesAll)) {
    const needles = rule.inputIncludesAll.filter((needle) => typeof needle === "string");
    if (!inputStrings.some((value) => needles.every((needle) => value.includes(needle)))) return false;
  }
  if (rule.inputTokenPattern instanceof RegExp) {
    if (!inputStrings.some((value) => splitTokens(value).some((token) => rule.inputTokenPattern.test(token)))) {
      return false;
    }
  }
  return true;
}

/**
 * The built-in house-rule deny set — a non-empty starting example a later phase can extend or replace. Mirrors the
 * forbidden-path regex in `scripts/check-mcp-package.mjs` (CI workflows, env files, secret-bearing paths, private
 * key material) and adds conservative git force-push guards (a command carrying `push` plus a force flag).
 */
export const DEFAULT_DENY_RULES = [
  { matcher: "*", pathPattern: "**/.github/workflows/**", reason: "Never modify CI workflows (.github/workflows/**)." },
  { matcher: "*", pathPattern: "**/.env*", reason: "Never read or write environment files (.env*)." },
  { matcher: "*", pathPattern: "**/.dev.vars", reason: "Never read or write local Worker secrets (.dev.vars)." },
  { matcher: "*", pathPattern: "**/.npmrc", reason: "Never read or write npm credential files (.npmrc)." },
  { matcher: "*", pathPattern: "**/*secret*/**", reason: "Never touch secret-bearing directories (**/*secret*/**)." },
  { matcher: "*", pathPattern: "**/*secret*", reason: "Never touch secret-bearing paths (**/*secret*)." },
  // Ordered before **/*.pem below: a file like id_private_key.pem matches both patterns, and
  // evaluateDenyHooks returns the first matching rule's reason — this one is more specific
  // (#2942, keeps the "private key material" reason for *private*key*.pem files).
  { matcher: "*", pathPattern: "**/*private*key*", reason: "Never touch private key material (**/*private*key*)." },
  { matcher: "*", pathPattern: "**/*.pem", reason: "Never touch PEM key material (*.pem)." },
  { matcher: "*", inputIncludesAll: ["push", "--force"], reason: "Never force-push (git push --force)." },
  // Token-matched rather than substring-matched: a substring test for "-f" would also fire on an
  // unrelated long flag like --follow-tags. Matches a whole short-option token (bundled or not)
  // whose letters include "f", e.g. -f, -uf, -fu, but not a "--"-prefixed long flag.
  { matcher: "*", inputIncludesAll: ["push"], inputTokenPattern: /^-[a-z]*f[a-z]*$/i, reason: "Never force-push (git push -f)." },
];

/**
 * Evaluate a proposed tool call against deny rules and return the first block, or allow. Pure and side-effect-free
 * — it NEVER runs or intercepts the tool call; a later phase's real hook wiring acts on the verdict. An empty rule
 * set (or a call matching no rule) always allows. Defaults to {@link DEFAULT_DENY_RULES} when no rules are given.
 */
export function evaluateDenyHooks(toolCall, rules = DEFAULT_DENY_RULES) {
  const toolName = toolCall && typeof toolCall === "object" ? toolCall.name : undefined;
  const inputStrings = collectInputStrings(toolCall && typeof toolCall === "object" ? toolCall.input : undefined);
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (ruleMatches(rule, toolName, inputStrings)) return { allowed: false, blockedBy: rule };
  }
  return { allowed: true };
}
