// SINGLE modular home for review GROUNDING (#review-grounding). Feeds the AI reviewer the FINISHED CI
// results + the FULL post-change content of the changed files, so a non-frontier model stops hallucinating
// CI outcomes ("this will break CI" on a green PR) and undefined symbols ("X is not defined" when it's
// defined 10 lines outside the visible hunk) — the #967 class of false blockers.
//
// Every review lane calls these helpers; ACTIVATION is a single `features.grounding` ConvergedFeatureKey
// (resolved via resolveConvergedFeature / convergedFeatureActive) plus the LOOPOVER_REVIEW_GROUNDING env
// kill-switch (default OFF). `ciGrounding` / `fullFileContext` below are internal GroundingFlags fields —
// today's one real caller (groundingFlags() in ./grounding-wire) always sets both identically; they are
// not independently-settable `.loopover.yml` keys. Fully fail-safe: any fetch error degrades to "no
// grounding" and the review proceeds on the diff alone.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→loopover convergence): every type + helper this module needs is
// defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot source
// (src/core/review-grounding.ts); the only deltas are (1) mechanical guards for loopover's stricter
// tsconfig (noUncheckedIndexedAccess + exactOptionalPropertyTypes), which do not change behavior, and
// (2) the one I/O dependency (GitHub file fetch) is INJECTED via the FileFetcher interface + explicit
// params instead of reviewbot's RunContext/ReviewTarget/github helpers, so fetchFullFileContents is
// self-contained and unit-testable. The host wires a real GitHub-backed FileFetcher at the call site.
// EXCEPTION (#7465-class fix): `sampleHeadAndTail` + the raised FILE_CONTENT_BUDGET/MAX_SINGLE_FILE/
// MAX_FETCH_CHARS below are a loopover-side-ONLY addition, not yet ported back to reviewbot's own
// review-grounding.ts -- if reviewbot's copy is ever resynced from this file, carry this piece forward too,
// or reviewbot will regress to the old all-or-nothing truncation this was written to eliminate.

import { isLockfile } from "../signals/path-matchers";
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
  /** How many commits the repo's CURRENT default branch has landed that this PR's HEAD commit doesn't have
   *  (#review-grounding stale-base fact, metagraphed #7305-class incident) — a TRUE, deterministic fact the
   *  reviewer can cite instead of guessing a content-level cause for an undetailed CI failure. Undefined when
   *  unreadable or zero (nothing to say); the caller only sets this when it is a positive number worth
   *  surfacing. */
  baseAheadBy?: number;
}

// Budgets so the full-file block fits the 120B context alongside the diff + RAG + project knowledge.
// Raised from 24k/60k (#7465-class fix: metagraphed PR #7465 was wrongly auto-closed because
// registry/subnets/eirel.json's 188KB post-change body — GitHub omits `patch` for a diff this large, so the
// bounded-diff builder had nothing either — blew straight through the old flat caps and rendered as a fully
// empty "(omitted — too large to inline; review this file from the diff)" placeholder with NO diff to fall
// back to either. The reviewer correctly said it couldn't verify a file it was never shown, and the one-shot
// gate closed the PR over an honest "I can't see this" rather than a confirmed defect.) These are now sized
// with real headroom relative to that 188KB incident file, but any FIXED cap is eventually defeated by
// growth — metagraphed's one-file-per-subnet registry only ever appends, so a subnet's file gets larger
// forever. The durable half of the fix is below: `sampleHeadAndTail` guarantees a file we successfully read
// is NEVER rendered as pure "omitted" content again, no matter how large it grows.
export const FILE_CONTENT_BUDGET = 96_000; // total chars inlined across all changed files
export const MAX_SINGLE_FILE = 48_000; // a file up to this size is inlined IN FULL; beyond it, head+tail SAMPLED
// The network-level read cap, decoupled from the two prompt budgets above: we always attempt to read the
// REAL, full file (up to this generous ceiling) so `sampleHeadAndTail` has genuine tail content to show —
// asking the fetcher for only `MAX_SINGLE_FILE` chars (the old behavior) would silently return a head-only
// prefix, which is exactly wrong for an append-oriented file where the NEW content lands at the end.
export const MAX_FETCH_CHARS = 1_000_000;
// Below this per-file share, a head+tail sample would be too thin on each side to carry real signal (mirrors
// review-diff.ts's `remaining < 240` guard style) — treat as unavailable rather than showing a sliver.
export const MIN_SAMPLE_CHARS = 400;
// Binary / generated / lockfile paths carry no review signal as full text — skip inlining them.
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|heic|svg|ico|pdf|lock|min\.js|min\.css|map|woff2?|ttf|eot|mp4|webm|zip|gz|tgz|wasm)$/i;

/**
 * When a successfully-read file's content doesn't fit in its allotted prompt `budget`, keep its HEAD and
 * TAIL rather than dropping it entirely (#7465-class fix). A file this large will often keep growing forever
 * (an append-only registry/manifest never shrinks), so no fixed budget can "cover" it permanently — the fix
 * is to never render zero content for a file we actually read, regardless of size: the file's START (its
 * top-level structure/preamble — proves no undisclosed metadata edits) and its END (new entries in an
 * append-oriented file typically land at the tail) both survive, with an honest, sized marker for whatever
 * was cut from the middle. Returns "" when `budget` is too small for a meaningful sample at all (below
 * {@link MIN_SAMPLE_CHARS}) — the caller treats that the same as an unreadable file.
 */
export function sampleHeadAndTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget < MIN_SAMPLE_CHARS) return "";
  const marker = (omittedChars: number) =>
    `\n\n… (${omittedChars.toLocaleString("en-US")} chars omitted from the middle of this file — shown below: its real start and end) …\n\n`;
  // Reserve space for the marker using the whole file's length as the omitted-count estimate — the actual
  // printed count (computed below from the real head/tail split) can only be smaller, so this is always a
  // safe (>=) upper bound on the marker's own rendered length.
  const reserve = marker(text.length).length;
  const available = budget - reserve;
  const headLen = Math.ceil(available / 2);
  const tailLen = available - headLen;
  const omitted = text.length - headLen - tailLen;
  // tailLen is always > 0 here: MIN_SAMPLE_CHARS (400, already checked above) comfortably exceeds the
  // marker's own rendered length (well under 150 chars even at astronomical omitted-counts), so
  // `available` -- and therefore `tailLen` -- can never reach 0. This matters because `"x".slice(-0)`
  // returns the WHOLE string (JS treats -0 as plain 0, i.e. "from the start"), not "" -- a tailLen of
  // exactly 0 would otherwise silently duplicate the head instead of omitting the tail.
  return `${text.slice(0, headLen)}${marker(omitted)}${text.slice(-tailLen)}`;
}

/** The grounding feature flags (subset of reviewbot's FeatureToggles). Two internal booleans of one
 *  GroundingFlags value — the type permits independent values so a future caller could split CI-summary
 *  vs full-file gathering, but today's only caller (`groundingFlags()` in `./grounding-wire`) always sets
 *  both from the single `features.grounding` / LOOPOVER_REVIEW_GROUNDING activation path. */
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
  "- A FAILED check marked '(no detail provided)' means you were given only its name, not its actual error output — you cannot know WHY it failed. Do not fill that gap with a guess. Writing something 'likely' failed for a specific content reason, or naming an example cause 'not visible in this diff', is STILL an unverified guess wearing a hedge — it is FORBIDDEN as a blocker, exactly like asserting a defect on a file you cannot see. State plainly that the check failed and its cause could not be verified from what you were given; do not name any hypothetical cause, hedged or not.",
  "- If a 'BASE BRANCH STATUS' section is present below, this PR's branch is a KNOWN, measured number of commits behind the default branch. For an undetailed FAILED check, prefer citing that TRUE fact as the likely cause (and suggest rebasing onto the latest default branch) over guessing a content-level defect — this is a verified fact, not a guess, so it is the correct thing to say instead of staying silent about the cause.",
  "- The FULL post-change content of the changed files is given below as 'FULL FILE CONTENT'. Before claiming any symbol, import, type, or export is undefined / unused / missing / wrong-signature, CHECK that file — only flag it if it is genuinely absent there.",
  "- A file marked 'showing this file's real start and end' is REAL content read from that file — a genuine partial sample (too large to include in full), not a placeholder. Use the visible start/end to spot-check structure, formatting, and consistency; do not claim confidence about the omitted middle section, and do not treat something merely ABSENT from the visible sample as proof it is missing from the file — say you could not verify that part instead.",
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
 *  fetched full file contents (`fileContents`) + the base-branch staleness fact (`baseAheadBy`), each gated by
 *  its flag. `baseAheadBy` rides the SAME `ciGrounding` flag as `checks` and additionally requires `checks` to
 *  be present too — it explains a CI STATUS section (formatBaseBranchSection reads "see CI STATUS above"), so
 *  rendering it with no CI section to point at would dangle. Only included when a positive number (0/undefined
 *  ⇒ nothing worth telling the reviewer). No I/O — pure. */
export function buildGrounding(f: GroundingFlags, checks?: CheckAggregate, fileContents?: ChangedFileContent[], baseAheadBy?: number): ReviewGrounding {
  return {
    ...(f.ciGrounding && checks ? { checks: toCiSummary(checks) } : {}),
    ...(f.fullFileContext && fileContents?.length ? { changedFileContents: fileContents } : {}),
    ...(f.ciGrounding && checks && typeof baseAheadBy === "number" && baseAheadBy > 0 ? { baseAheadBy } : {}),
  };
}

// ── Diff priority (ported from reviewbot src/core/diff.ts diffFilePriority) ───────────────────────
/** Review priority for diff ordering. When the budget is tight, SOURCE survives and
 *  lockfiles/generated/docs/tests are dropped first (least useful to a code reviewer). Lower = kept.
 *  Test detection delegates to the canonical `isTestPath` so this matcher can't drift from it (the inline
 *  copy missed pytest `test_*.py`, Go `*_test.go`, Ruby `*_spec.rb`, Cypress/Playwright `.cy`/`.e2e`, and a
 *  bare `spec/` dir — so those tests ranked as SOURCE(0) and were inlined ahead of real source). */
export function diffFilePriority(path: string): number {
  // Lockfile-NAME matching delegates to the canonical isLockfile/LOCKFILE_NAMES so no copy of this
  // function can drift from the shared set (the #4605 Finding 1 class); suffix patterns stay inline.
  if (isLockfile(path) || /\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
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

  const observed = countObservedHunkChanges(file.patch);
  if (observed.additions !== file.additions || observed.deletions !== file.deletions) return false;

  return oldCount - observed.deletions < DIFF_CONTEXT_LINES && newCount - observed.additions < DIFF_CONTEXT_LINES;
}

function countObservedHunkChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n").slice(1)) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
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
    // Always ask for the REAL file up to the generous network ceiling — never a per-file prompt-budget
    // slice — so a file bigger than its prompt share still has genuine tail content for sampleHeadAndTail
    // to show (#7465-class fix; see MAX_FETCH_CHARS).
    let text: string | null = null;
    try {
      text = await fetcher.getFileContent(file.filename, ref, MAX_FETCH_CHARS);
    } catch {
      text = null;
    }
    if (text == null) continue; // unreadable (binary / vanished / perms) — skip silently
    const share = Math.min(MAX_SINGLE_FILE, FILE_CONTENT_BUDGET - used);
    if (text.length <= share) {
      out.push({ path: file.filename, text });
      used += text.length;
      continue;
    }
    const sampled = sampleHeadAndTail(text, share);
    if (!sampled) {
      // The remaining share was too thin for even a head+tail sample to carry signal — same as unreadable.
      out.push({ path: file.filename, text: "", truncated: true });
      used = FILE_CONTENT_BUDGET;
      continue;
    }
    out.push({ path: file.filename, text: sampled, truncated: true });
    used += sampled.length;
  }
  return out.length ? out : undefined;
}

/** Render the grounding into prompt sections (shared by every lane's prompt builder). "" when empty. */
export function formatGroundingSections(g?: ReviewGrounding): string {
  if (!g) return "";
  const parts: string[] = [];
  if (g.checks) parts.push(formatCiSection(g.checks));
  if (typeof g.baseAheadBy === "number" && g.baseAheadBy > 0) parts.push(formatBaseBranchSection(g.baseAheadBy));
  if (g.changedFileContents?.length) parts.push(formatFilesSection(g.changedFileContents));
  return parts.join("\n\n");
}

/** BASE BRANCH STATUS section (metagraphed #7305-class incident): a TRUE, deterministic fact — this PR's base
 *  commit is measurably behind the repo's current default branch — that the reviewer can cite as the likely
 *  cause of an undetailed CI failure instead of guessing a content-level defect. Only rendered when the caller
 *  supplied a positive count (see buildGrounding). */
function formatBaseBranchSection(aheadBy: number): string {
  return [
    "BASE BRANCH STATUS:",
    `- This PR's branch is based on a commit that is ${aheadBy} commit${aheadBy === 1 ? "" : "s"} behind the repository's current default branch.`,
    "- A CI failure (see CI STATUS above) on a branch this far behind is frequently caused by code that landed on the default branch AFTER this PR's branch diverged — not a defect in this PR's own changes.",
  ].join("\n");
}

function formatCiSection(c: ReviewCiSummary): string {
  if (c.state === "pending") return "CI STATUS: checks still running on this commit — do not assume an outcome.";
  const passed = c.passing.length ? c.passing.join(", ") : "(none)";
  // A failing check with no `summary` means the caller never got the check's own error output (e.g. a generic
  // CI runner's check-run carries no output.title/summary beyond pass/fail) — mark that gap explicitly, in-line
  // next to the fact itself, rather than relying on the model to remember a rule stated once in the system
  // prompt. This is what GROUNDING_GUIDANCE's "(no detail provided)" instruction below reacts to.
  const failed = c.failing.length ? c.failing.map((x) => (x.summary ? `${x.name} — ${x.summary}` : `${x.name} (no detail provided)`)).join("; ") : "(none)";
  const verdict = c.state === "passed" ? "ALL checks PASSED — the build/typecheck/tests already succeeded on this exact commit." : "Some checks FAILED.";
  return ["CI STATUS (already finished on this commit — do NOT predict CI):", `- ${verdict}`, `- PASSED: ${passed}`, `- FAILED: ${failed}`].join("\n");
}

function formatFilesSection(files: ChangedFileContent[]): string {
  const blocks = files.map((file) => {
    const path = safeGroundingPath(file.path);
    // truncated + no text: the per-PR budget was already spent on higher-priority files before this one's
    // turn — genuinely nothing to show (rare; #7465-class fix: a file we DID manage to read is never
    // reduced to this, see the `truncated + text` branch below).
    if (file.truncated && !file.text) return `### ${path}\n(no content available — the per-PR review budget was already spent on higher-priority files)`;
    const text = neutralizePromptInjection(file.text).text;
    const fence = safeMarkdownFence(text);
    // truncated + text: a real head+tail sample (see sampleHeadAndTail) — too large to include in full, but
    // never a contentless placeholder.
    const note = file.truncated ? "\n(too large to include in full — showing this file's real start and end; see the marker below for what's cut)\n" : "";
    return `### ${path}${note}${fence}\n${text}\n${fence}`;
  });
  return ["FULL FILE CONTENT (post-change, head ref — check here before claiming any symbol is undefined/unused):", "", blocks.join("\n\n")].join("\n");
}

function safeGroundingPath(path: string): string {
  return neutralizePromptInjection(path).text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function safeMarkdownFence(text: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}
