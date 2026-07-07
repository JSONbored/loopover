import { isConfigFile, isDocsFile } from "../signals/path-matchers";
import { isTestPath } from "../signals/test-evidence";

// Deterministic category taxonomy for AI review findings (#1958). The model is asked to self-categorize each
// inlineFinding when review.finding_categories is on; `inferFindingCategory` supplies the SAFE DEFAULT for
// whatever it omits or mis-emits, so a caller with the feature on always has a category to render — never a
// sometimes-present field. Pure, path/keyword-only — no diff content, no IO.

export const FINDING_CATEGORIES = ["security", "correctness", "performance", "maintainability", "tests", "style"] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Type guard for a model-provided `category` value — anything outside the fixed enum (wrong case, a made-up
 *  category, a non-string) is rejected so the caller falls back to {@link inferFindingCategory}. */
export function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

const SECURITY_KEYWORDS =
  /\b(?:sql injection|xss|cross-site scripting|csrf|authentication|authorization|secret|credential|vulnerab\w*|sanitiz\w*|command injection|path traversal|ssrf|deserializ\w*|hardcoded (?:password|key|token)|insecure)\b/i;
const PERFORMANCE_KEYWORDS =
  /\b(?:performance|\bslow\b|n\+1|memory leak|inefficient|redundant (?:call|fetch|query)|unnecessary re-?render|blocking call|latency|throughput)\b/i;
const TEST_KEYWORDS = /\b(?:test coverage|missing test|flaky test|test case|assertion)\b/i;
const STYLE_KEYWORDS = /\b(?:naming|formatting|whitespace|indentation|lint\w*|style guide|typo)\b/i;
const MAINTAINABILITY_KEYWORDS =
  /\b(?:duplicat\w*|refactor\w*|readability|overly complex|magic number|dead code|unused (?:variable|import|function))\b/i;

/**
 * Deterministic fallback categorization (#2148, part of #1958). Documented precedence:
 *
 *  1. PATH signals (a finding anchored to a file of a known kind IS that kind, regardless of body wording,
 *     because the file the reviewer is pointing at is the strongest deterministic signal we have):
 *       - a test file  → "tests"          (`isTestPath`)
 *       - a docs file  → "style"          (`isDocsFile`; wording/clarity is the docs analogue of code style)
 *       - a config file → "maintainability" (`isConfigFile`; build/setup upkeep, not a runtime defect)
 *  2. KEYWORD buckets over the finding's own body text, ordered so the costliest miscategorization (missing a
 *     real security defect) is checked first: security → performance → tests → style → maintainability.
 *  3. Final DEFAULT "correctness" — the general "this is a bug" bucket — when nothing above matches.
 *
 * Pure: path + body text only, no diff content, no IO. `classifyFindingCategory` is a thin object-shaped
 * adapter kept for existing call sites; both share this one implementation so the fallback never drifts.
 */
export function inferFindingCategory(body: string, path: string): FindingCategory {
  if (isTestPath(path)) return "tests";
  if (isDocsFile(path)) return "style";
  if (isConfigFile(path)) return "maintainability";
  if (SECURITY_KEYWORDS.test(body)) return "security";
  if (PERFORMANCE_KEYWORDS.test(body)) return "performance";
  if (TEST_KEYWORDS.test(body)) return "tests";
  if (STYLE_KEYWORDS.test(body)) return "style";
  if (MAINTAINABILITY_KEYWORDS.test(body)) return "maintainability";
  return "correctness";
}

/** Object-shaped adapter over {@link inferFindingCategory} for call sites that hold a `{ path, body }` finding
 *  (inline-comment rendering, category tallies). Delegates so the deterministic fallback stays single-sourced. */
export function classifyFindingCategory(finding: { path: string; body: string }): FindingCategory {
  return inferFindingCategory(finding.body, finding.path);
}
