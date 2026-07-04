// Deterministic security/abuse scan for content submissions (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/awesome-claude/security-scan.ts + the shared core/secrets-scan.ts (inlined here so the
// module is self-contained). PURE — data in, data out, no I/O.
//
// Design principle (learned via adversarial review): the gate AUTO-CLOSES at high confidence with NO
// human queue, so a false-positive close PERMANENTLY rejects a legitimate submission — the worst
// outcome. Therefore only ONE signal is unambiguous enough to hard-close: a concrete embedded
// credential (a real-format token IS a leak regardless of framing). Every other abuse heuristic
// (pipe-to-shell installers, prompt-injection prose, "exfil-looking" code) is indistinguishable at
// the regex level from legitimate documentation or defensive-security tooling — so it routes to
// MANUAL (a human decides), never an auto-close.

// ── Inlined secret-pattern scanner (reviewbot core/secrets-scan.ts) ───────────────────────────
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "private_key_block", re: /-----BEGIN(?: RSA| EC| OPENSSH| PGP| DSA)? PRIVATE KEY-----/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab_token", re: /\bglpat-[0-9A-Za-z_-]{20}\b/ },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Stripe live secret / restricted keys: `sk_live_` / `rk_live_` + >=24 base62.
  { name: "stripe_secret_key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
  // SendGrid API key: `SG.` + 22-char id + `.` + 43-char secret (base64url).
  { name: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  // Hugging Face user access token: `hf_` + 34 base62 chars.
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{34}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "seed_or_mnemonic", re: /\b(?:seed phrase|mnemonic)\b/i },
  { name: "bittensor_key", re: /\b(?:hot|cold)key\b\s*[:=]/i },
];

// Deliberately NOT in SECRET_PATTERNS above: unlike the format-specific patterns (a real GitHub token/AWS key
// ALWAYS matches its exact character format, so a bare .test() is precise enough), a keyword-plus-quoted-value
// SHAPE also matches plenty of non-secrets -- a Zod schema field (`password: z.string()`), a TypeScript type
// declaration, or a placeholder value ("xxx", "your-api-key-here", "<REDACTED>"). Captured so each match's
// VALUE can be checked against isPlaceholderSecretValue before counting as a hit; the value itself is never
// returned from this module (only the kind name), preserving the existing never-echo-the-secret guarantee.
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,})["']/gi;

const PLACEHOLDER_VALUE_PATTERN = /placeholder|change[_-]?me|your[_-]|<[^>]*>|\bexample\b|redacted|dummy|\bsample\b|\btodo\b|\bfixme\b|\binsert\b|replace[_-]?me|\bfake\b/i;

// A string with NO repeated characters (e.g. "abcdefghijklmnop123") has HIGH Shannon entropy by raw
// character-frequency counting, but is obviously not a real secret -- entropy alone only measures frequency,
// not ORDER, so a keyboard-sequential/alphabetical run slips past a pure distinct-character-count check. Detect
// the longest run of consecutive ascending or descending character codes (e.g. "abcdefg" or "9876543") and
// treat a long one as a human-constructed test value, not a randomly generated credential -- real API
// keys/tokens essentially never contain a 6+ character monotonic run.
const MIN_SEQUENTIAL_RUN_LENGTH = 6;
function hasLongSequentialRun(value: string): boolean {
  let ascendingRun = 1;
  let descendingRun = 1;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    ascendingRun = diff === 1 ? ascendingRun + 1 : 1;
    descendingRun = diff === -1 ? descendingRun + 1 : 1;
    if (ascendingRun >= MIN_SEQUENTIAL_RUN_LENGTH || descendingRun >= MIN_SEQUENTIAL_RUN_LENGTH) return true;
  }
  return false;
}

/** True for an obvious non-secret filler value: a known placeholder phrase, a string built from at most 2
 *  distinct characters (e.g. "xxxxxxxxxxxxxxxx", "----------------"), or a long monotonic character-code run
 *  (e.g. "abcdefghijklmnop123") — real high-entropy secrets never look like any of these. */
function isPlaceholderSecretValue(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (new Set(value.toLowerCase()).size <= 2) return true;
  return hasLongSequentialRun(value);
}

function hasGenericSecretAssignment(text: string): boolean {
  // No zero-length-match / lastIndex-stall guard needed: the pattern's captured value alone requires 16+
  // characters, so every match is well over 16 characters long and lastIndex always advances past match.index.
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    // The pattern's sole capturing group is mandatory (not `?`/`*`-wrapped), so it is always present
    // whenever the overall match succeeds -- non-null by construction, not a runtime branch.
    if (!isPlaceholderSecretValue(match[1]!)) return true;
  }
  return false;
}

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

/** Scan a string for known credential / secret patterns. Deterministic, no deps. */
export function scanForSecrets(text: string): SecretScanResult {
  if (!text) return { found: false, kinds: [] };
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return { found: kinds.length > 0, kinds };
}

// ── Submission security scan ──────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  verdict: "close" | "manual";
  reasonCode: string;
  summary: string;
}

// Categories whose entries ship a maintainer-authored EXECUTABLE artifact (a script that runs): used
// for the pipe-to-shell install check (manual-flag) and the first-party grounding relaxation.
export const EXECUTABLE_CATEGORIES = new Set(["skills", "agents", "commands", "hooks", "mcp", "statuslines"]);

// Concrete credential formats only — NOT the weak heuristics (seed phrase / hot|coldkey) that would
// false-positive on legitimate Bittensor content. #2553: google_api_key/jwt are as format-precise as the
// original five (near-zero false-positive risk), and generic_secret_assignment already excludes
// placeholder/type-declaration/schema-shaped matches (see isPlaceholderSecretValue) before the kind is ever
// produced, so all three are safe unconditional hard blockers — keeping this gate in parity with the PR-diff
// gate it mirrors (safety.ts's HARD_SECRET_KINDS / secrets-scan.ts).
const HARD_SECRET_KINDS = new Set([
  "github_token",
  "github_pat",
  "private_key_block",
  "aws_access_key",
  "slack_token",
  "google_api_key",
  "gitlab_token",
  "npm_token",
  "stripe_secret_key",
  "sendgrid_key",
  "huggingface_token",
  "jwt",
  "generic_secret_assignment",
]);

// A literal pipe-to-shell install. Common in legitimate installers (uv/rustup/deno/nvm), so this is a
// MANUAL flag for a human, never an auto-close.
const PIPED_INSTALL_RE = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python3?|node)\b/i;

function firstLineMatching(text: string, re: RegExp): { n: number; text: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i] ?? "")) return { n: i + 1, text: (lines[i] ?? "").trim().slice(0, 160) };
  }
  return null;
}

function firstSecretLine(text: string): { n: number; kinds: string[] } | null {
  // Per-line scan first — O(n): catches every LINE-CONTAINED hard kind (github_token, jwt, …) and cites its
  // exact line. lines[i] is defined for an in-range index (split never yields holes) — assert past
  // noUncheckedIndexedAccess.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const hits = scanForSecrets(lines[i]!).kinds.filter((k) => HARD_SECRET_KINDS.has(k));
    if (hits.length) return { n: i + 1, kinds: hits };
  }
  // The only HARD kind whose keyword-to-value span can WRAP across lines is generic_secret_assignment, so the
  // per-line scan above can miss it (`client_secret =\n"…"`). Recover it with ONE whole-blob pass over just that
  // detector — LINEAR, not the quadratic prefix-rescan — citing the line where the non-placeholder match
  // COMPLETES, so scanSubmissionContent's auto-close stays in parity with the whole-blob PR-diff gate.
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    if (!isPlaceholderSecretValue(match[1]!)) {
      const n = text.slice(0, match.index + match[0].length).split(/\r?\n/).length;
      return { n, kinds: ["generic_secret_assignment"] };
    }
  }
  return null;
}

/**
 * Deterministic security scan of the SUBMITTED content. Returns:
 *  - `close` (embedded_secret) on a concrete embedded credential — cited to a line; or
 *  - `manual` (unsafe_install_pipeline) on a pipe-to-shell install in an executable category; or
 *  - null otherwise.
 * Prompt-injection / exfiltration prose is intentionally NOT matched here: it is indistinguishable
 * from legitimate prompt-engineering content, and is left to the grounded dual-AI review.
 */
export function scanSubmissionContent(params: { content: string; category: string }): SecurityFinding | null {
  const { content, category } = params;
  if (!content) return null;

  const secret = firstSecretLine(content);
  if (secret) {
    return {
      verdict: "close",
      reasonCode: "embedded_secret",
      summary: `Submission embeds a credential (${secret.kinds.join(", ")}) at line ${secret.n}. Remove the secret and resubmit.`,
    };
  }

  if (EXECUTABLE_CATEGORIES.has(category)) {
    const pipe = firstLineMatching(content, PIPED_INSTALL_RE);
    if (pipe) {
      return {
        verdict: "manual",
        reasonCode: "unsafe_install_pipeline",
        summary: `Pipe-to-shell install detected (line ${pipe.n}): \`${pipe.text}\` — routing to maintainer review for a ${category} entry.`,
      };
    }
  }
  return null;
}

/** A concrete credential exposed in a LINKED third-party body → manual (flag for a human; don't
 *  auto-close someone's submission over the linked artifact's own leak). */
export function scanLinkedBodiesForSecrets(bodies: string[]): SecurityFinding | null {
  for (const body of bodies) {
    const hits = scanForSecrets(body).kinds.filter((k) => HARD_SECRET_KINDS.has(k));
    if (hits.length) {
      return {
        verdict: "manual",
        reasonCode: "embedded_secret",
        summary: `The linked source appears to expose a credential (${hits.join(", ")}) — routing to maintainer review.`,
      };
    }
  }
  return null;
}
