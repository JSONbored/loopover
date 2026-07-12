// Reusable secret-pattern scanner (the `secretsScan` capability). Deterministic, no deps.
// Callers run scanForSecrets() on submitted diff/text; a hit typically forces a close/manual verdict.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): byte-faithful to the reviewbot source
// (src/core/secrets-scan.ts); there are no stricter-tsconfig deltas — the module is already total. No
// imports from reviewbot.
//
// #4608: the format-specific patterns + placeholder-value heuristics are shared with
// content-lane/security-scan.ts via ./secret-patterns (both live under src/, same build, same deploy — no
// deploy-independence reason to hand-duplicate them; that duplication already caused two independent,
// currently-live drifts, see #4587/#4604). review-enrichment/src/analyzers/secret-scan.ts (REES) stays a
// genuinely separate, deliberately wider copy — not imported here — because REES deploys standalone on
// Railway with its own tsconfig/build/test pipeline; the same reasoning this file used to document for
// itself before the #4608 extraction. See ./secret-patterns's header and
// scripts/check-engine-parity.ts's SECRET_DETECTION_TWIN_PAIR for how REES's copy is kept from drifting.

import { hasGenericSecretAssignment, secretPatternMatches, SECRET_PATTERNS } from "./secret-patterns";

// #3041: the one place the pattern list (format-specific SECRET_PATTERNS + the generic keyword-assignment
// heuristic) is applied to a string. Both `scanForSecrets` (whole-text scan) and
// `scanDiffForSecretsWithLocations` (per-line diff scan, for file:line attribution) delegate here so there is
// exactly one implementation of "does this text contain secret-shaped content" to keep in sync.
function matchedKindsIn(text: string): string[] {
  if (!text) return [];
  const kinds = SECRET_PATTERNS.filter((pattern) => secretPatternMatches(pattern, text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return kinds;
}

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  const kinds = matchedKindsIn(text);
  return { found: kinds.length > 0, kinds };
}

/** One secret-pattern hit at a specific location in a diff, for surfacing file:line in a finding (#3041). A
 *  `line` of `0` means the match came from a file-header PATH itself (an added/renamed filename), not from
 *  diff content — there is no line number for that case. */
export interface SecretScanLocationMatch {
  kind: string;
  path: string;
  line: number;
}

const DIFF_FILE_HEADER_PATTERN = /^### (.+) \(([a-z]+)\) \+\d+\/-\d+$/;
const DIFF_HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Walk a `buildSecretScanDiff`-shaped diff (see src/queue/processors.ts) line by line, scanning only content
 * this PR is INTRODUCING — added (`+`) lines and, for an added/renamed file, the path in its own section
 * header — and return every pattern hit with its file path and 1-based line number in the new/post-change
 * file. Context (` `) and removed (`-`) lines are tracked for line-number bookkeeping but never scanned: a
 * removed or unchanged line is not something this PR is committing. This mirrors the added-only scanning
 * `secretLeakFinding` used to do via string filtering, but keeps enough diff structure to report WHERE a hit
 * lives instead of collapsing everything to a flat blob.
 */
export function scanDiffForSecretsWithLocations(diff: string): SecretScanLocationMatch[] {
  const matches: SecretScanLocationMatch[] = [];
  let currentPath = "";
  let currentNewLine = 0;
  for (const line of diff.split("\n")) {
    const fileHeader = DIFF_FILE_HEADER_PATTERN.exec(line);
    if (fileHeader) {
      currentPath = fileHeader[1]!;
      currentNewLine = 0;
      const status = fileHeader[2]!;
      if (status === "added" || status === "renamed") {
        for (const kind of matchedKindsIn(currentPath)) {
          matches.push({ kind, path: currentPath, line: 0 });
        }
      }
      continue;
    }
    const hunkHeader = DIFF_HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      currentNewLine = Number(hunkHeader[1]) - 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentNewLine += 1;
      const content = line.slice(1);
      for (const kind of matchedKindsIn(content)) {
        matches.push({ kind, path: currentPath, line: currentNewLine });
      }
      continue;
    }
    if (line.startsWith("-")) continue;
    // Context line (single leading space) or a blank separator between file sections -- either way it isn't
    // new content this PR introduces, but a genuine context line still occupies a line in the new file.
    currentNewLine += 1;
  }
  return matches;
}
