// Unpinned GitHub Actions analyzer (#1500). Scans changed .github/workflows/* for third-party actions referenced by
// a MUTABLE tag/branch (@v3, @main) instead of a full commit SHA — the tj-actions/changed-files supply-chain class,
// where a compromised upstream tag silently re-points and runs in your CI with your secrets. Pure compute, no network.
// Official actions/* + github/* are excluded (lowest risk, extremely common) to keep the signal high. Line-cited.
import type { EnrichRequest, ActionPinFinding } from "../types.js";

const USES_RE = /^\s*-?\s*["']?uses["']?\s*:\s*["']?([\w.-]+\/[\w./-]+)@([^\s"'#]+)/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const OFFICIAL = /^(actions|github)\//;
const WORKFLOW_PATH = /^\.github\/workflows\/.+\.ya?ml$/;

/** Scan one workflow patch's added lines for unpinned third-party `uses:` refs, line-cited via hunk headers. Pure. */
export function scanWorkflowPins(
  path: string,
  patch: string,
): ActionPinFinding[] {
  const findings: ActionPinFinding[] = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
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
    if (WORKFLOW_PATH.test(file.path) && file.patch) {
      findings.push(...scanWorkflowPins(file.path, file.patch));
    }
  }
  return findings;
}
