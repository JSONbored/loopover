// Secret-scan analyzer (#1476). Scans the ADDED lines of the PR diff for credential patterns and high-entropy
// assignments, citing file:line and the KIND only — the matched secret VALUE is never returned (so the brief is
// safe to splice into a public review). Higher-recall than the engine's in-process regex pass, and line-cited via
// the hunk headers so the reviewer can point at the exact line.
import type { EnrichRequest, SecretFinding } from "../types.js";

interface Rule {
  kind: string;
  re: RegExp;
  confidence: "high" | "medium";
}

// Ordered specific → generic. The generic assignment rule is medium-confidence (it catches real keys but also the
// occasional long opaque non-secret), so the reviewer treats it as "verify" rather than "block".
const RULES: Rule[] = [
  { kind: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/, confidence: "high" },
  {
    kind: "github_token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    confidence: "high",
  },
  {
    kind: "slack_token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    confidence: "high",
  },
  {
    kind: "google_api_key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    confidence: "high",
  },
  {
    kind: "private_key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    confidence: "high",
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    confidence: "medium",
  },
  {
    kind: "generic_secret_assignment",
    re: /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i,
    confidence: "medium",
  },
];

/** Scan one file's unified-diff patch, tracking new-file line numbers via hunk headers. Pure. Value never captured. */
export function scanPatch(path: string, patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      const content = line.slice(1);
      for (const rule of RULES) {
        if (rule.re.test(content)) {
          findings.push({
            file: path,
            line: newLine,
            kind: rule.kind,
            confidence: rule.confidence,
          });
          break; // one finding per line — first (most specific) rule wins
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++; // context line advances the new-file counter; removed lines do not
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's patch for leaked credentials. */
export async function scanSecrets(
  req: EnrichRequest,
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of req.files ?? []) {
    if (file.patch) findings.push(...scanPatch(file.path, file.patch));
  }
  return findings;
}
