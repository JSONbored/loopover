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
  { name: "seed_or_mnemonic", re: /\b(?:seed phrase|mnemonic)\b/i },
  { name: "bittensor_key", re: /\b(?:hot|cold)key\b\s*[:=]/i },
];

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

/** Scan a string for known credential / secret patterns. Deterministic, no deps. */
export function scanForSecrets(text: string): SecretScanResult {
  if (!text) return { found: false, kinds: [] };
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
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
// false-positive on legitimate Bittensor content.
const HARD_SECRET_KINDS = new Set(["github_token", "github_pat", "private_key_block", "aws_access_key", "slack_token"]);

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
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const hits = scanForSecrets(lines[i] ?? "").kinds.filter((k) => HARD_SECRET_KINDS.has(k));
    if (hits.length) return { n: i + 1, kinds: hits };
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
