// GitHub Actions workflow-injection / "pwn request" analyzer. Scans changed .github/workflows/* patches for the
// classic trust-boundary break: a workflow that runs with an ELEVATED token/context against ATTACKER-CONTROLLED
// input. `pull_request_target` and `workflow_run` both run in the base repo's context (secrets + a
// read/write token) even for a fork PR, unlike plain `pull_request` (fork PRs get a read-only token there, so
// it is never flagged). Pure compute, line-scanned from the diff — no repo checkout, same shape as the
// actions-pin/iac-misconfig siblings.
import type { EnrichRequest, WorkflowInjectionFinding } from "../types.js";
import { isWorkflowPath } from "../workflow-path.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// The two triggers that hand a fork PR's event payload to a workflow running with base-repo privilege. Word
// boundaries keep `pull_request_target` from also matching the (safe) plain `pull_request` trigger.
const UNSAFE_TRIGGER_RE = /\b(?:pull_request_target|workflow_run)\b/;
const PULL_REQUEST_TARGET_RE = /\bpull_request_target\b/;

// A job-level GitHub Environment (`environment:` key) requires manual approval before the job runs, which is the
// standard mitigation for a `pull_request_target` checkout of untrusted code. Its presence anywhere in the diff's
// visible lines is treated as evidence of an approval gate (a coarse, file-scoped signal — see docs.notes).
const ENVIRONMENT_KEY_RE = /^\s*environment:\s*(?:\S.*)?$/;
// A top-level (or job-level) `permissions:` key narrows the default `GITHUB_TOKEN` scope. Its absence from the
// diff's visible lines is the signal for rule 3 (see docs.notes for the same diff-only caveat).
const PERMISSIONS_KEY_RE = /^\s*permissions:\s*(?:\S.*)?$/;

// A `ref:` step input bound to the untrusted PR head — the checkout step that actually pulls in attacker-authored
// code onto a runner that otherwise has base-repo secrets and a writable token.
const UNTRUSTED_REF_RE =
  /^\s*ref:\s*["']?\$\{\{\s*(?:github\.event\.pull_request\.head\.(?:sha|ref|label)|github\.head_ref)\s*\}\}/;

// A `run:` step key — either as a step's own key (`  run: ...`) or as the FIRST key of a step's YAML list item
// (`  - run: ...`) — optionally introducing a block scalar (`|`/`>`, with an optional chomp/indent indicator and
// digit). Group 1 is the column `run:` itself starts at (the list-item dash, when present, is absorbed into it so
// it lines up with where a sibling key like `if:`/`shell:` would be written), group 2 the block indicator
// (undefined for an inline scalar), group 3 any inline content on the same line.
const RUN_BLOCK_START_RE = /^(\s*(?:-\s+)?)run:\s*([|>][+-]?\d*)?\s*(.*)$/;
// The first non-whitespace column of a line, used to tell whether a line still belongs to a `run:` block scalar
// (deeper indent than the `run:` key) or has closed it (same-or-shallower indent, i.e. a sibling key or a new step).
const FIRST_COLUMN_RE = /^(\s*)\S/;

// Untrusted event fields commonly interpolated straight into a shell string. The safe pattern routes each of
// these through an `env:` entry first (`TITLE: ${{ github.event.pull_request.title }}`) and references the shell
// variable in `run:` (`echo "$TITLE"`) — that never matches this pattern because the `${{ }}` never appears
// inside the `run:` block itself.
const UNSAFE_EVENT_FIELD_RE =
  /\$\{\{\s*(?:github\.event\.pull_request\.(?:title|body|head\.ref|head\.label)|github\.event\.issue\.(?:title|body)|github\.event\.comment\.body|github\.head_ref)\s*\}\}/;

/**
 * Scan one workflow file's patch for injection/pwn-request risk, line-cited via hunk headers. Pure — never
 * parses the YAML into a document, so there is nothing for malformed YAML to fail to parse; a file with no
 * recognizable elevated-trust trigger (or pure noise) simply yields no findings.
 */
export function scanPatchForWorkflowInjection(
  path: string,
  patch: string,
  maxFindings = MAX_FINDINGS,
): WorkflowInjectionFinding[] {
  if (maxFindings <= 0) return [];

  const findings: WorkflowInjectionFinding[] = [];
  const untrustedCheckoutLines: number[] = [];

  let newLine = 0;
  let inHunk = false;
  let inRunBlock = false;
  let runBlockIndent = -1;
  let hasUnsafeTrigger = false;
  let hasPullRequestTarget = false;
  let pullRequestTargetLine = 0;
  let hasEnvironmentGate = false;
  let hasPermissions = false;

  for (const rawLine of patch.split("\n")) {
    const hunk = HUNK_RE.exec(rawLine);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      inRunBlock = false;
      runBlockIndent = -1;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;

    // A `-` removed line is old-file-only content: it does not exist in the new file, so it neither advances
    // the new-file line counter nor contributes to trigger/gate/interpolation detection. `\` marks
    // "No newline at end of file" and is likewise not a content line (same class as the actions-pin/iac-misconfig
    // fix for this).
    if (rawLine.startsWith("-") || rawLine.startsWith("\\")) continue;

    const isAdded = rawLine.startsWith("+");
    // Both an added line (`+`) and an unchanged context line (leading space) represent real NEW-file content —
    // context lines matter here because the elevated trigger or an existing `permissions:`/`environment:` key is
    // often untouched while the PR only adds a new step nearby (the diff's surrounding context still shows it).
    const body = rawLine.slice(1);

    if (body.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }

    if (UNSAFE_TRIGGER_RE.test(body)) hasUnsafeTrigger = true;
    if (PULL_REQUEST_TARGET_RE.test(body)) {
      hasPullRequestTarget = true;
      pullRequestTargetLine = newLine;
    }
    if (ENVIRONMENT_KEY_RE.test(body)) hasEnvironmentGate = true;
    if (PERMISSIONS_KEY_RE.test(body)) hasPermissions = true;

    const runStart = RUN_BLOCK_START_RE.exec(body);
    if (runStart) {
      const indent = runStart[1]!.length;
      // Group 3 (`(.*)$`) is not optional, so it always participates in a successful match (possibly as ""); the
      // non-null assertion just tells TS what `noUncheckedIndexedAccess` cannot infer on its own.
      const inline = runStart[3]!;
      if (isAdded && inline && UNSAFE_EVENT_FIELD_RE.test(inline)) {
        findings.push({ file: path, line: newLine, kind: "unsafe-interpolation" });
      }
      inRunBlock = Boolean(runStart[2]);
      runBlockIndent = indent;
    } else if (inRunBlock) {
      const firstColumn = FIRST_COLUMN_RE.exec(body);
      const indent = firstColumn ? firstColumn[1]!.length : Number.POSITIVE_INFINITY;
      if (indent <= runBlockIndent) {
        inRunBlock = false;
        runBlockIndent = -1;
      } else if (isAdded && UNSAFE_EVENT_FIELD_RE.test(body)) {
        findings.push({ file: path, line: newLine, kind: "unsafe-interpolation" });
      }
    }

    if (isAdded && UNTRUSTED_REF_RE.test(body)) {
      untrustedCheckoutLines.push(newLine);
    }

    newLine++;
  }

  if (!hasUnsafeTrigger) return [];

  if (hasPullRequestTarget && !hasPermissions) {
    // pullRequestTargetLine is only ever set while processing a real content line inside a hunk (the loop above
    // never tests PULL_REQUEST_TARGET_RE outside that guard), so hasPullRequestTarget can never be true here with
    // pullRequestTargetLine still at its 0 initial value.
    findings.push({
      file: path,
      line: pullRequestTargetLine,
      kind: "missing-permissions",
    });
  }

  if (untrustedCheckoutLines.length && !hasEnvironmentGate) {
    for (const line of untrustedCheckoutLines) {
      findings.push({ file: path, line, kind: "untrusted-checkout" });
    }
  }

  return findings.slice(0, maxFindings);
}

/** Analyzer entrypoint: scan every changed workflow file for injection/pwn-request risk. */
export async function scanWorkflowInjection(
  req: EnrichRequest,
): Promise<WorkflowInjectionFinding[]> {
  const findings: WorkflowInjectionFinding[] = [];
  for (const file of req.files ?? []) {
    if (!isWorkflowPath(file.path) || !file.patch) continue;
    const remaining = MAX_FINDINGS - findings.length;
    if (remaining <= 0) break;
    findings.push(
      ...scanPatchForWorkflowInjection(file.path, file.patch, remaining),
    );
  }
  return findings;
}
