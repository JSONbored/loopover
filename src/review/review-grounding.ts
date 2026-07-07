// SINGLE modular home for review GROUNDING (#review-grounding). Feeds the AI reviewer the FINISHED CI
// results + the FULL post-change content of the changed files, so a non-frontier model stops hallucinating
// CI outcomes ("this will break CI" on a green PR) and undefined symbols ("X is not defined" when it's
// defined 10 lines outside the visible hunk) — the #967 class of false blockers.
//
// Every review lane calls these helpers; ACTIVATION is per-project via features.ciGrounding /
// features.fullFileContext (default OFF — wire once here, flip on per chain from its config). Fully
// fail-safe: any fetch error degrades to "no grounding" and the review proceeds on the diff alone.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + helper this module needs is
// defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot source
// (src/core/review-grounding.ts); the only deltas are (1) mechanical guards for gittensory's stricter
// tsconfig (noUncheckedIndexedAccess + exactOptionalPropertyTypes), which do not change behavior, and
// (2) the one I/O dependency (GitHub file fetch) is INJECTED via the FileFetcher interface + explicit
// params instead of reviewbot's RunContext/ReviewTarget/github helpers, so fetchFullFileContents is
// self-contained and unit-testable. The host wires a real GitHub-backed FileFetcher at the call site.

import { isTestPath } from "../signals/test-evidence";
import { neutralizePromptInjection } from "./prompt-injection";

// ── Inlined minimal types (ported from reviewbot src/core/types.ts) ──────────────────────────────

/** Compact, prompt-ready CI summary fed to the reviewer (the FINISHED state of a commit's checks). */
export interface ReviewCiSummary {
  state: "passed" | "failed" | "pending";
  /** Names of checks that passed (success/neutral/skipped). */
  passing: string[];
  /** Failing checks WITH the one-line reason (codecov %, the failing test, etc.). */
  failing: Array<{ name: string; summary?: string }>;
}

/** Full post-change content of one changed file (head ref) fed to the reviewer; `truncated` = too large to inline. */
export interface ChangedFileContent {
  path: string;
  text: string;
  truncated?: boolean;
}

/** A changed file in the PR (subset of reviewbot's PullRequestFile that grounding reads). `patch` +
 *  `additions`/`deletions` are optional so a caller that hasn't wired them through still type-checks;
 *  without them a modified file is simply never recognized as fully-covered-by-diff (falls back to
 *  fetching, same as before -- see `diffFullyCoversFile`). */
export interface PullRequestFile {
  filename: string;
  status?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

export interface ReviewGrounding {
  checks?: ReviewCiSummary;
  changedFileContents?: ChangedFileContent[];
}

// Budgets so the full-file block fits the 120B context alongside the diff + RAG + project knowledge.
const FILE_CONTENT_BUDGET = 60_000; // total chars inlined across all changed files
const MAX_SINGLE_FILE = 24_000; // a file larger than this is marked truncated (review it from the diff)
// Binary / generated / lockfile paths carry no review signal as full text — skip inlining them.
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|heic|svg|ico|pdf|lock|min\.js|min\.css|map|woff2?|ttf|eot|mp4|webm|zip|gz|tgz|wasm)$/i;

/** The grounding feature flags (subset of reviewbot's FeatureToggles). */
export interface GroundingFlags {
  ciGrounding: boolean;
  fullFileContext: boolean;
}

/** True when any grounding feature is on for this project. */
export function groundingEnabled(f: GroundingFlags): boolean {
  return !!(f.ciGrounding || f.fullFileContext);
}

// Non-gameable grounding discipline appended to the reviewer's SYSTEM prompt when grounding is on. Generic
// framework guidance (a contributor can't control how the model reconciles its claims against CI / the
// real file), so it lives in committed code — like NIT_GUIDANCE — not the private rubric store.
const GROUNDING_GUIDANCE = [
  "",
  "",
  "GROUNDING — verify every concern against the provided reality before raising it (you are a smaller model; do not guess):",
  "- CI has ALREADY finished on this commit; its results are given below as 'CI STATUS'. NEVER predict a CI / build / typecheck / test outcome. If a check is under PASSED, that path is verified — do not claim the change breaks it. Treat something as a CI failure ONLY if it appears under FAILED.",
  "- The FULL post-change content of the changed files is given below as 'FULL FILE CONTENT'. Before claiming any symbol, import, type, or export is undefined / unused / missing / wrong-signature, CHECK that file — only flag it if it is genuinely absent there.",
  "- If verifying a concern needs a file that is NOT provided, say you could not verify it; do NOT assert a defect on code you cannot see.",
].join("\n");

/** Grounding-discipline system-prompt suffix — "" when no grounding flag is on (the prompt is unchanged). */
export function groundingSystemSuffix(f: GroundingFlags): string {
  return groundingEnabled(f) ? GROUNDING_GUIDANCE : "";
}

/** Shape of the full check aggregate (getAllChecksState) — the lanes already fetch this for their own
 *  gate/readiness decision, so CI grounding REUSES it (zero extra API calls) via buildGrounding. */
type CheckAggregate = { state: "passed" | "failed" | "pending"; passing: string[]; failingDetails: Array<{ name: string; summary?: string }> };

/** Compact, prompt-ready CI summary from the full check aggregate (getAllChecksState). */
export function toCiSummary(all: CheckAggregate): ReviewCiSummary {
  return {
    state: all.state,
    passing: all.passing,
    failing: all.failingDetails.map((d) => ({ name: d.name, ...(d.summary ? { summary: d.summary } : {}) })),
  };
}

/** Assemble the grounding the prompt renders from a lane's ALREADY-fetched CI (`checks`) + the centrally
 *  fetched full file contents (`fileContents`), each gated by its flag. No I/O — pure. */
export function buildGrounding(f: GroundingFlags, checks?: CheckAggregate, fileContents?: ChangedFileContent[]): ReviewGrounding {
  return {
    ...(f.ciGrounding && checks ? { checks: toCiSummary(checks) } : {}),
    ...(f.fullFileContext && fileContents?.length ? { changedFileContents: fileContents } : {}),
  };
}

// ── Diff priority (ported from reviewbot src/core/diff.ts diffFilePriority) ───────────────────────
/** Review priority for diff ordering. When the budget is tight, SOURCE survives and
 *  lockfiles/generated/docs/tests are dropped first (least useful to a code reviewer). Lower = kept.
 *  Test detection delegates to the canonical `isTestPath` so this matcher can't drift from it (the inline
 *  copy missed pytest `test_*.py`, Go `*_test.go`, Ruby `*_spec.rb`, Cypress/Playwright `.cy`/`.e2e`, and a
 *  bare `spec/` dir — so those tests ranked as SOURCE(0) and were inlined ahead of real source). */
export function diffFilePriority(path: string): number {
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum|go\.work\.sum|uv\.lock|packages\.lock\.json|flake\.lock|deno\.lock|pubspec\.lock|podfile\.lock|mix\.lock|package\.resolved|gradle\.lockfile|pdm\.lock|conan\.lock|pixi\.lock|cartfile\.resolved|gopkg\.lock|shard\.lock|rebar\.lock|renv\.lock|chart\.lock)$|\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
  if (/(^|\/)(dist|build|out|coverage|vendor|node_modules)\//i.test(path)) return 4;
  if (/\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i.test(path)) return 2;
  if (isTestPath(path)) return 1;
  return 0; // source code
}

/** The single I/O dependency, INJECTED so this module is self-contained + unit-testable: fetch the FULL
 *  post-change text of one file at a ref, returning null when unreadable (binary / vanished / perms). The
 *  host adapts reviewbot's getRepositoryFileContent (or any backend) to this shape at the call site. */
export interface FileFetcher {
  getFileContent(path: string, ref: string, maxChars?: number): Promise<string | null>;
}

// ── Modified-file dedup (#3897 follow-up): a hunk-header check for "the diff already IS the whole file" ──

/** Unified-diff hunk header: `@@ -oldStart,oldCount +newStart,newCount @@` (a bare number with no comma
 *  means count 1, standard unified-diff shorthand). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** git's default unified-diff context window (`-U3`): the MAXIMUM number of unchanged lines it will ever
 *  show around a change, whether or not more unchanged content follows. This makes it a strict ambiguity
 *  boundary, not slack — a hunk carrying FEWER than this many trailing unchanged lines proves the file
 *  truly ends there (git would never truncate below its own configured context), but a hunk carrying
 *  EXACTLY this many is ambiguous: it could be the true end of file, or git could have capped a longer
 *  unchanged tail at the context window. Only the unambiguous case may skip the fetch. */
const DIFF_CONTEXT_LINES = 3;

/**
 * True when a MODIFIED file's diff hunk already PROVABLY covers its entire post-change body, making the
 * separate full-file fetch a byte-for-byte duplicate of what the diff itself sent — the same waste #3918
 * targeted for added files (since reverted for them by #3976, whose reasoning does NOT apply here: this
 * check, unlike a blanket status==="added" skip, is proven per-file from the hunk math itself, not assumed
 * from status alone). A single hunk starting at line 1 on both sides, whose unchanged-line count (old/new
 * count minus deletions/additions) is STRICTLY BELOW `DIFF_CONTEXT_LINES`, cannot have any untouched tail:
 * if more unchanged file remained, git's default context would have shown exactly `DIFF_CONTEXT_LINES`
 * lines regardless, so seeing fewer proves there was nothing left to show (verified against real `git
 * diff` output). Seeing exactly `DIFF_CONTEXT_LINES` is deliberately treated as NOT proven — the context
 * window could be capping a longer tail — so this falls back to fetching, the safe default.
 * Deliberately scoped to `status === "modified"` (or absent, for a caller that never sets it) only --
 * "added"/"renamed"/other statuses fall through to `false` (the safe default: fetch the full file) so
 * this can never re-skip an added file's fetch, which #3976 restored because GitHub can omit/truncate an
 * added file's patch on large files without any hunk-count anomaly for this check to catch.
 */
export function diffFullyCoversFile(file: PullRequestFile): boolean {
  if (file.status !== undefined && file.status !== "modified") return false;
  if (!file.patch || file.additions === undefined || file.deletions === undefined) return false;
  const hunks = file.patch.split("\n").filter((line) => line.startsWith("@@"));
  if (hunks.length !== 1) return false; // multiple hunks ⇒ an unchanged (and unseen) gap sits between them
  const match = HUNK_HEADER.exec(hunks[0]!);
  if (!match) return false;
  const oldStart = Number.parseInt(match[1]!, 10);
  const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
  const newStart = Number.parseInt(match[3]!, 10);
  const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
  if (oldStart > 1 || newStart > 1) return false; // leading unchanged lines exist before the hunk
  return oldCount - file.deletions < DIFF_CONTEXT_LINES && newCount - file.additions < DIFF_CONTEXT_LINES;
}

/** Centrally fetch the FULL post-change content of changed files (the one grounding input no lane fetches
 *  otherwise). Flag-gated + bounded + fully fail-safe — returns undefined when off or on any error. The
 *  caller passes the already-resolved head ref + a FileFetcher (vs reviewbot's RunContext/ReviewTarget). */
export async function fetchFullFileContents(
  flags: GroundingFlags,
  ref: string | undefined,
  files: PullRequestFile[],
  fetcher: FileFetcher,
): Promise<ChangedFileContent[] | undefined> {
  if (!flags.fullFileContext || !ref) return undefined;
  // Source-first ordering (the diff's own priority) so the most-relevant files are inlined before the budget runs out.
  // Added files still need grounding: the review diff is budgeted and GitHub can omit inline patches for
  // large/binary-ish files, so the full-file fallback must not assume every added line reached the prompt.
  // A MODIFIED file is excluded only when its own hunk header proves it already carries the whole file
  // (see diffFullyCoversFile) -- a strictly narrower, provable case than "added", so it can't reintroduce
  // the #3976 gap: anything less than full-hunk proof still falls through to the fetch.
  const candidates = files
    .filter((file) => file.status !== "removed" && !SKIP_EXT.test(file.filename) && !diffFullyCoversFile(file))
    .sort((a, b) => diffFilePriority(a.filename) - diffFilePriority(b.filename));
  const out: ChangedFileContent[] = [];
  let used = 0;
  for (const file of candidates) {
    if (used >= FILE_CONTENT_BUDGET) {
      out.push({ path: file.filename, text: "", truncated: true });
      continue;
    }
    let text: string | null = null;
    try {
      text = await fetcher.getFileContent(file.filename, ref, Math.min(MAX_SINGLE_FILE, FILE_CONTENT_BUDGET - used) + 1);
    } catch {
      text = null;
    }
    if (text == null) continue; // unreadable (binary / vanished / perms) — skip silently
    if (text.length > MAX_SINGLE_FILE || used + text.length > FILE_CONTENT_BUDGET) {
      out.push({ path: file.filename, text: "", truncated: true });
      used = FILE_CONTENT_BUDGET;
      continue;
    }
    out.push({ path: file.filename, text });
    used += text.length;
  }
  return out.length ? out : undefined;
}

/** Render the grounding into prompt sections (shared by every lane's prompt builder). "" when empty. */
export function formatGroundingSections(g?: ReviewGrounding): string {
  if (!g) return "";
  const parts: string[] = [];
  if (g.checks) parts.push(formatCiSection(g.checks));
  if (g.changedFileContents?.length) parts.push(formatFilesSection(g.changedFileContents));
  return parts.join("\n\n");
}

function formatCiSection(c: ReviewCiSummary): string {
  if (c.state === "pending") return "CI STATUS: checks still running on this commit — do not assume an outcome.";
  const passed = c.passing.length ? c.passing.join(", ") : "(none)";
  const failed = c.failing.length ? c.failing.map((x) => (x.summary ? `${x.name} — ${x.summary}` : x.name)).join("; ") : "(none)";
  const verdict = c.state === "passed" ? "ALL checks PASSED — the build/typecheck/tests already succeeded on this exact commit." : "Some checks FAILED.";
  return ["CI STATUS (already finished on this commit — do NOT predict CI):", `- ${verdict}`, `- PASSED: ${passed}`, `- FAILED: ${failed}`].join("\n");
}

function formatFilesSection(files: ChangedFileContent[]): string {
  const blocks = files.map((file) => {
    if (file.truncated) return `### ${file.path}\n(omitted — too large to inline; review this file from the diff)`;
    const text = neutralizePromptInjection(file.text).text;
    const fence = safeMarkdownFence(text);
    return `### ${file.path}\n${fence}\n${text}\n${fence}`;
  });
  return ["FULL FILE CONTENT (post-change, head ref — check here before claiming any symbol is undefined/unused):", "", blocks.join("\n\n")].join("\n");
}

function safeMarkdownFence(text: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}
