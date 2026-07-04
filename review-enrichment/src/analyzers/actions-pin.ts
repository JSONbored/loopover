// Unpinned GitHub Actions analyzer (#1500). Scans changed .github/workflows/* for third-party actions referenced by
// a MUTABLE tag/branch (@v3, @main) instead of a full commit SHA — the tj-actions/changed-files supply-chain class,
// where a compromised upstream tag silently re-points and runs in your CI with your secrets. Pure compute, no network.
// Official actions/* + github/* are excluded (lowest risk, extremely common) to keep the signal high. Line-cited.
import type { EnrichRequest, ActionPinFinding } from "../types.js";
import { isWorkflowPath } from "../workflow-path.js";

const USES_RE =
  /^\s*-?\s*["']?uses["']?\s*:\s*["']?([\w.-]+\/[\w./-]+)@([^\s"'#]+)/;
// Git commit SHAs are case-insensitive; accept uppercase/mixed-case 40-char hex so a pin like
// `@A1B2…` is not mis-flagged as a mutable tag/branch.
const FULL_SHA = /^[0-9a-f]{40}$/i;
// GitHub org/user names are case-insensitive (mirrors isWorkflowPath's case-insensitive path match), so the
// official-action exclusion matches case-insensitively — otherwise `Actions/checkout` would be mis-flagged as a
// mutable third-party action. GitHub reserves the `actions`/`github` orgs, so this can never over-match a real one.
const OFFICIAL = /^(actions|github)\//i;

/** Scan one workflow patch's added lines for unpinned third-party `uses:` refs, line-cited via hunk headers. Pure. */
export function scanWorkflowPins(
  path: string,
  patch: string,
): ActionPinFinding[] {
  const findings: ActionPinFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const match = USES_RE.exec(line.slice(1));
      if (match) {
        const action = match[1]!;
        const ref = match[2]!;
        if (!OFFICIAL.test(action) && !FULL_SHA.test(ref)) {
          findings.push({ file: path, line: newLine, action, ref });
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed workflow file for unpinned third-party actions. */
export async function scanActionPins(
  req: EnrichRequest,
): Promise<ActionPinFinding[]> {
  const findings: ActionPinFinding[] = [];
  for (const file of req.files ?? []) {
    if (isWorkflowPath(file.path) && file.patch) {
      findings.push(...scanWorkflowPins(file.path, file.patch));
    }
  }
  return findings;
}
