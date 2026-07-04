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
    // GitHub fine-grained personal access token (GitHub's recommended default): `github_pat_` + 82
    // base62/underscore chars. The classic `gh[pousr]_` rule above never matches this prefix.
    kind: "github_pat",
    re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/,
    confidence: "high",
  },
  {
    // Slack tokens: bot/user/app/refresh/session (`baprs`) plus enterprise (`e`) and cookie (`c`).
    kind: "slack_token",
    re: /\bxox[baprsec]-[A-Za-z0-9-]{10,}\b/,
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
    // Stripe secret / restricted key: `sk_`/`rk_` + `live` or `test` + >=24 base62.
    // Test-mode keys (`sk_test_` / `rk_test_`) are still credentials and must not be committed.
    kind: "stripe_secret_key",
    re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/,
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
    // Anthropic API key: `sk-ant-` + base64url body. Distinct from Stripe `sk_live_` (underscore).
    // Negative-lookahead terminator (not `\b`) so a body ending in `-` still matches, like SendGrid.
    kind: "anthropic_api_key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // OpenAI project-scoped API key: `sk-proj-` + base64url body. Distinct from Anthropic `sk-ant-`
    // and Stripe `sk_live_`/`sk_test_`. Negative-lookahead terminator for bodies ending in `-`/`_`.
    kind: "openai_project_key",
    re: /\bsk-proj-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // DigitalOcean personal access token: `dop_v1_` + 64 hex chars (case-insensitive).
    kind: "digitalocean_token",
    re: /\bdop_v1_[a-f0-9]{64}\b/i,
    confidence: "high",
  },
  {
    // Shopify Admin API access token (`shpat_`) or app shared secret (`shpss_`) + 32 hex chars.
    kind: "shopify_token",
    re: /\bshp(?:at|ss)_[a-f0-9]{32}\b/i,
    confidence: "high",
  },
  {
    // Postman API key: `PMAK-` + 24 hex + `-` + 34 hex.
    kind: "postman_api_key",
    re: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/,
    confidence: "high",
  },
  {
    // Doppler personal token: `dp.pt.` + 43 base62.
    kind: "doppler_token",
    re: /\bdp\.pt\.[A-Za-z0-9]{43}\b/,
    confidence: "high",
  },
  {
    // Linear API key: `lin_api_` + 40 base62.
    kind: "linear_api_key",
    re: /\blin_api_[A-Za-z0-9]{40}\b/,
    confidence: "high",
  },
  {
    // New Relic user API key: `NRAK-` + 27 base62 (distinct from the NRJS-/NRII- license/ingest keys).
    kind: "newrelic_user_key",
    re: /\bNRAK-[A-Za-z0-9]{27}\b/,
    confidence: "high",
  },
  {
    // PyPI upload token: `pypi-` + the fixed `AgEIcHlwaS5vcmc` macaroon marker + base64url body. No
    // trailing \b — the base64url body may end in `-`/`_`.
    kind: "pypi_upload_token",
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/,
    confidence: "high",
  },
  {
    // Grafana service-account token: `glsa_` + 32 base62 + `_` + 8-hex checksum.
    kind: "grafana_service_account_token",
    re: /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/,
    confidence: "high",
  },
  {
    // Dynatrace token: `dt0c01.` + 24 + `.` + 64, uppercase-alnum, three-part fixed shape.
    kind: "dynatrace_token",
    re: /\bdt0c01\.[A-Z0-9]{24}\.[A-Z0-9]{64}\b/,
    confidence: "high",
  },
  {
    // age (Filippo Valsorda) secret key: `AGE-SECRET-KEY-1` + 58 uppercase Bech32 chars.
    kind: "age_secret_key",
    re: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/,
    confidence: "high",
  },
  {
    // Clojars deploy token: `CLOJARS_` + 60 base62.
    kind: "clojars_token",
    re: /\bCLOJARS_[A-Za-z0-9]{60}\b/,
    confidence: "high",
  },
  {
    // Square access/OAuth token: `sq0` + 3-letter type + `-` + 22-43 base64url. Lookahead terminator
    // since the body can end in `-`/`_`.
    kind: "square_token",
    re: /\bsq0[a-z]{3}-[A-Za-z0-9_-]{22,43}(?![A-Za-z0-9_-])/,
    confidence: "high",
  },
  {
    // Notion internal integration secret: `secret_` + 43 base62 chars (50 chars total).
    kind: "notion_integration_secret",
    re: /\bsecret_[A-Za-z0-9]{43}\b/,
    confidence: "high",
  },
  {
    // Mailgun private API key: `key-` + 32 alphanumeric chars.
    kind: "mailgun_api_key",
    re: /\bkey-[0-9A-Za-z]{32}\b/,
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
          findings.push({ file: path, line: newLine, kind: rule.kind, confidence: rule.confidence });
          matched = true;
          break; // one finding per line — first (most specific) rule wins
        }
      }
      const currentLiterals = extractStringLiteralContents(content);
      // Bounded: only the immediately-preceding line's LAST literal joined with this line's FIRST literal — the
      // common "two sequential variable assignments" shape. Skipped once this line already matched on its own.
      const lastPrevious = previousLiterals.at(-1);
      const firstCurrent = currentLiterals[0];
      if (!matched && lastPrevious !== undefined && firstCurrent !== undefined) {
        const joined = lastPrevious + firstCurrent;
        for (const rule of RULES) {
          if (rule.re.test(joined)) {
            // "medium" regardless of the rule's own confidence — a joined pair is a heuristic, not a direct match.
            findings.push({ file: path, line: newLine, kind: rule.kind, confidence: "medium" });
            break;
          }
        }
      }
      previousLiterals = currentLiterals;
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // Context line advances the new-file counter; removed lines and `\ No newline at end of
      // file` markers do not (same class as the iac-misconfig / redos / secret-log fix).
      newLine++;
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
