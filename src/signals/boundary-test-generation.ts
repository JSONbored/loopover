import type { AdvisoryFinding } from "../types";
import { isCodeFile } from "./path-matchers";
import { isTestPath, hasLocalTestEvidence } from "./test-evidence";

// #1972 boundary-safe test generation. Detecting missing test evidence in general (test-evidence.ts) is a
// coarse, path-only signal; this module adds a NARROW, precise layer on top: does a changed diff actually
// touch one of a small set of well-known boundary-condition patterns (off-by-one array/index bounds,
// null/undefined branches, empty-collection edge cases) with NO test evidence anywhere in the same PR? Full
// test-code generation is deliberately OUT of scope (server-side generated test code would need a human to
// verify it is even correct, which risks false confidence) — this only builds a LOCAL-execution action spec
// (mirrors `local-write-tools.ts`'s pattern) that hands the contributor's OWN agent the criteria to scaffold
// tests with, so gittensory never writes code and the boundary between review and execution stays intact.

/** A changed source file's path plus its unified-diff patch text (added/removed lines only — no full file
 *  content). Deliberately narrower than `PullRequestFileRecord` so callers (MCP tools, tests) can supply just
 *  the metadata this module needs without depending on the wider PR-file record shape. */
export type BoundaryPatchInput = {
  path: string;
  /** Unified-diff patch text (e.g. `file.payload.patch`). Absent/empty ⇒ no boundary patterns can be detected
   *  for this file (fail-safe: never guesses from a path alone). */
  patch?: string | null | undefined;
};

export type BoundaryPatternKind = "array_index_bounds" | "null_or_undefined_branch" | "empty_collection_check";

export type BoundaryTouch = {
  path: string;
  kind: BoundaryPatternKind;
};

// Kept deliberately SMALL and PRECISE (per #1972's scope note: false positives are worse than a narrow
// true-positive set). Each pattern only matches an ADDED line (a line starting with a single `+`, not `++`
// which is the `+++ b/file` patch header) so this only ever reacts to genuinely new code, never context lines
// or the file the diff is against.
const ARRAY_INDEX_BOUNDS_PATTERN = /\[\s*(?:[\w.]+\.length|[\w.]+\.length\s*-\s*1|-1)\s*\]|\.length\s*(?:-\s*1)?\s*[<>]=?/;
const NULL_OR_UNDEFINED_BRANCH_PATTERN = /(?:===?|!==?)\s*(?:null|undefined)\b|\b(?:null|undefined)\s*(?:===?|!==?)|\?\?|\?\./;
const EMPTY_COLLECTION_CHECK_PATTERN = /\.length\s*(?:===?|!==?|[<>]=?)\s*0\b|\blen\(.*\)\s*(?:===?|!==?|[<>]=?)\s*0\b|\.(?:isEmpty|is_empty)\s*\(/;

const BOUNDARY_PATTERNS: ReadonlyArray<{ kind: BoundaryPatternKind; pattern: RegExp }> = [
  { kind: "array_index_bounds", pattern: ARRAY_INDEX_BOUNDS_PATTERN },
  { kind: "null_or_undefined_branch", pattern: NULL_OR_UNDEFINED_BRANCH_PATTERN },
  { kind: "empty_collection_check", pattern: EMPTY_COLLECTION_CHECK_PATTERN },
];

const MAX_TOUCHES = 20;

/** Added-line prefix in a unified diff: a single leading `+` not followed by another `+` (which would be the
 *  `+++ b/file` header line). */
function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
}

/**
 * Scan changed source files' patches for the small, precise set of boundary-condition patterns. Path-only
 * (non-code) files are skipped, and a file with no patch text yields no touches (fail-safe: absence of patch
 * data is never treated as evidence of a boundary touch). PURE.
 */
export function detectBoundaryTouches(files: BoundaryPatchInput[]): BoundaryTouch[] {
  const touches: BoundaryTouch[] = [];
  for (const file of files) {
    if (!file.path || !isCodeFile(file.path) || isTestPath(file.path)) continue;
    const patch = file.patch ?? "";
    if (!patch) continue;
    for (const line of addedLines(patch)) {
      for (const { kind, pattern } of BOUNDARY_PATTERNS) {
        if (!pattern.test(line)) continue;
        touches.push({ path: file.path, kind });
        if (touches.length >= MAX_TOUCHES) return touches;
        break; // one match per line is enough signal; avoid double-counting the same line across patterns
      }
    }
  }
  return touches;
}

const PATTERN_LABELS: Record<BoundaryPatternKind, string> = {
  array_index_bounds: "array/index bounds",
  null_or_undefined_branch: "null/undefined branch",
  empty_collection_check: "empty-collection check",
};

/**
 * Deterministic advisory finding: this PR's diff touches a boundary-condition pattern with no accompanying
 * test evidence anywhere in the PR. Mirrors `buildMissingTestEvidenceFinding` (slop.ts) in shape and severity
 * — advisory (`warning`), never a hard blocker on its own; a maintainer opts a repo's gate into treating any
 * `warning` finding as a blocker via the SAME general mechanisms already in place for other advisory findings,
 * not something this module decides. Returns null when there is nothing to flag (no boundary touches, or test
 * evidence is already present) — the caller only pushes a finding when this returns non-null, so an unconfigured
 * or evidence-covered repo sees byte-identical behavior.
 */
export function buildBoundaryTestGenerationFinding(input: {
  files?: BoundaryPatchInput[] | undefined;
  touches?: BoundaryTouch[] | undefined;
  tests?: string[] | undefined;
  testFiles?: string[] | undefined;
}): AdvisoryFinding | null {
  const touches = input.touches ?? detectBoundaryTouches(input.files ?? []);
  if (touches.length === 0) return null;
  if (hasLocalTestEvidence({ tests: input.tests, testFiles: input.testFiles })) return null;

  const kinds = Array.from(new Set(touches.map((touch) => touch.kind))).map((kind) => PATTERN_LABELS[kind]);
  const paths = Array.from(new Set(touches.map((touch) => touch.path)));
  const detail = `This PR touches ${kinds.join(", ")} in ${paths.length} file(s) (${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}) with no test evidence in the diff.`;
  return {
    code: "boundary_test_generation_available",
    severity: "warning",
    title: "Boundary-condition code changed without test evidence",
    detail,
    action: "Scaffold a boundary-condition test with your own agent (see the suggested test-generation spec), or add one by hand.",
    publicText: detail,
  };
}

export type BoundaryTestGenerationSpec = {
  action: "scaffold_boundary_tests";
  description: string;
  /** The boundary touches this spec was generated from — path + pattern kind only, never source text. */
  touches: BoundaryTouch[];
  /** Natural-language hints the contributor's own agent uses to scaffold tests in the repo's own framework and
   *  conventions — content supplied by gittensory, execution stays on the contributor's machine. */
  hints: string[];
  boundary: string;
};

// Reuses the exact boundary-disclosure string local-write-tools.ts uses for every other local-execution spec,
// so the no-cloud-write guarantee reads identically across every action gittensory ever proposes.
const BOUNDARY_TEST_GENERATION_BOUNDARY =
  "This is a suggestion, not a generated test file. Run it locally with your OWN agent/toolchain and the repo's own test framework — gittensory supplies the criteria but never writes or executes test code.";

const KIND_HINTS: Record<BoundaryPatternKind, string> = {
  array_index_bounds: "Add a case at the first/last valid index and one just past each bound (index -1, index === length).",
  null_or_undefined_branch: "Add a case for the null/undefined side of the branch and one for the present/defined side.",
  empty_collection_check: "Add a case with an empty collection (length 0) and one with at least one element.",
};

/**
 * Build the boundary-safe test-generation action spec: criteria + framework/convention hints for the
 * contributor's OWN agent to scaffold tests from — never test code itself, and never executed by gittensory.
 * Returns null when there are no boundary touches (nothing to generate hints for).
 */
export function buildBoundaryTestGenerationSpec(touches: BoundaryTouch[]): BoundaryTestGenerationSpec | null {
  if (touches.length === 0) return null;
  const kinds = Array.from(new Set(touches.map((touch) => touch.kind)));
  const hints = kinds.map((kind) => KIND_HINTS[kind]);
  return {
    action: "scaffold_boundary_tests",
    description: "Scaffold boundary-condition tests for the changed code, using your repo's existing test framework and conventions.",
    touches,
    hints,
    boundary: BOUNDARY_TEST_GENERATION_BOUNDARY,
  };
}
