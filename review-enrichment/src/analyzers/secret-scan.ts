// Secret-scan analyzer (#1476). Scans the ADDED lines of the PR diff for credential patterns and high-entropy
// assignments, citing file:line and the KIND only — the matched secret VALUE is never returned (so the brief is
// safe to splice into a public review). Higher-recall than the engine's in-process regex pass, and line-cited via
// the hunk headers so the reviewer can point at the exact line.
import type { AddedLine } from "../analysis-context.js";
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
    // GitLab personal/project/group access token: `glpat-` + 20 base64url chars.
    kind: "gitlab_token",
    re: /\bglpat-[0-9A-Za-z_-]{20}\b/,
    confidence: "high",
  },
  {
    // npm automation/publish token: `npm_` + 36 base62 chars.
    kind: "npm_token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/,
    confidence: "high",
  },
  {
    // Stripe live secret / restricted key: `sk_live_` / `rk_live_` + >=24 base62.
    kind: "stripe_secret_key",
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/,
    confidence: "high",
  },
  {
    // SendGrid API key: `SG.` + 22-char id + `.` + 43-char secret (base64url).
    kind: "sendgrid_key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Hugging Face user access token: `hf_` + 34 base62 chars.
    kind: "huggingface_token",
    re: /\bhf_[A-Za-z0-9]{34}\b/,
    confidence: "high",
  },
  {
    // Anthropic API key: `sk-ant-` prefix + base64url body (e.g. `sk-ant-api03-…`).
    // Distinct from Stripe's `sk_live_` / `rk_live_` (underscore) and OpenAI's bare `sk-` keys.
    // Terminator is a negative lookahead (not `\b`) so a body ending in `-` still matches — same
    // style as the SendGrid rule above.
    kind: "anthropic_api_key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
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

/** Extract the inner text of every quoted string literal (single/double/backtick) on a line. Used to catch a
 *  secret whose literal value is split across two adjacent added lines and joined at runtime (e.g.
 *  `const a = "AKIA..."; const b = a + "REST";`) — pure per-line regex matching never sees the runtime-joined
 *  value, only the two separate source literals either side of the `+`. */
function extractStringLiteralContents(line: string): string[] {
  const literals: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) literals.push(match[0].slice(1, -1));
  return literals;
}

/** Scan one file's unified-diff patch, tracking new-file line numbers via hunk headers. Pure. Value never captured. */
export function scanPatch(path: string, patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  // Last added line's extracted string-literal contents, for the cross-line join check below. Reset whenever a
  // non-added line breaks the run — a secret is only plausibly split across CONSECUTIVE added lines.
  let previousLiterals: string[] = [];
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      previousLiterals = [];
      continue;
    }
    // Skip the pre-hunk preamble (diff/index + the `+++ `/`--- ` file headers). INSIDE a hunk the first char is
    // the +/-/space op, so an added line whose content starts with `++` (rendered `+++x` or `+++ x`) is scanned,
    // not mistaken for a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const content = line.slice(1);
      let matched = false;
      for (const rule of RULES) {
        if (rule.re.test(content)) {
          findings.push({
            file: path,
            line: newLine,
            kind: rule.kind,
            confidence: rule.confidence,
          });
          matched = true;
          break; // one finding per line — first (most specific) rule wins
        }
      }
      const currentLiterals = extractStringLiteralContents(content);
      // Bounded: only the immediately-preceding line's LAST literal joined with this line's FIRST literal — the
      // common "two sequential variable assignments" shape. Skipped once this line already matched on its own.
      const lastPrevious = previousLiterals.at(-1);
      const firstCurrent = currentLiterals[0];
      if (
        !matched &&
        lastPrevious !== undefined &&
        firstCurrent !== undefined
      ) {
        const joined = lastPrevious + firstCurrent;
        for (const rule of RULES) {
          if (rule.re.test(joined)) {
            // "medium" regardless of the rule's own confidence — a joined pair is a heuristic, not a direct match.
            findings.push({
              file: path,
              line: newLine,
              kind: rule.kind,
              confidence: "medium",
            });
            break;
          }
        }
      }
      previousLiterals = currentLiterals;
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++; // context line advances the new-file counter; removed lines do not
      previousLiterals = [];
    } else {
      previousLiterals = [];
    }
  }
  return findings;
}

export function scanAddedLinesForSecrets(
  addedLines: readonly AddedLine[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const line of addedLines) {
    for (const rule of RULES) {
      if (rule.re.test(line.text)) {
        findings.push({
          file: line.file,
          line: line.line,
          kind: rule.kind,
          confidence: rule.confidence,
        });
        break;
      }
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
