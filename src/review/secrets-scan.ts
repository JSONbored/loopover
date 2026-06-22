// Reusable secret-pattern scanner (the `secretsScan` capability). Deterministic, no deps.
// Callers run scanForSecrets() on submitted diff/text; a hit typically forces a close/manual verdict.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + pattern this module needs is
// defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot source
// (src/core/secrets-scan.ts); there are no stricter-tsconfig deltas — the module is already total.

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

export function scanForSecrets(text: string): SecretScanResult {
  if (!text) return { found: false, kinds: [] };
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  return { found: kinds.length > 0, kinds };
}
