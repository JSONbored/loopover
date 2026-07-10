// Shared subprocess env-allowlist + secret-redaction helpers (#4284). Any driver that spawns a locally-authenticated
// CLI (the review `claude`/`codex` subprocess in src/selfhost/ai.ts, and the coding-agent drivers coming in
// gittensory-miner) needs the SAME two safety primitives: hand the child a STRICT allowlisted env (never the full
// worker/host env, which can carry runtime credentials into a prompt-injectable subprocess), and redact well-known
// secret shapes out of the child's untrusted stderr before it reaches logs. This module is the single engine-hosted
// source of truth for both, so those callers depend on one implementation instead of copy-pasting the pattern.

/**
 * The standard env-var allowlist for a locally-authenticated CLI subprocess: home + proxy + TLS-cert + locale +
 * XDG config paths, so the CLI keeps its own auth/proxy/cert settings, but nothing else (no runtime secrets) leaks
 * in. A caller that needs a different/larger set (e.g. a coding-agent driver) passes its own list to
 * {@link buildAllowlistedEnv} rather than editing this one.
 */
export const SUBPROCESS_CLI_ENV_ALLOWLIST = [
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

/**
 * Build a child-process env by copying ONLY `allowlist` keys from `parent`, then overlaying `extra`. Parameterized
 * (the allowlist is a caller argument, not hardcoded) so different subprocess kinds can use different allowlists.
 * `undefined` values are dropped from both sources; `extra` wins over an allowlisted parent value for the same key.
 * Pure — never reads the ambient process env itself.
 */
export function buildAllowlistedEnv(
  parent: Record<string, string | undefined>,
  allowlist: readonly string[],
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = {};
  for (const key of allowlist) {
    const value = parent[key];
    if (value !== undefined) child[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) child[key] = value;
  }
  return child;
}

/** Well-known secret token shapes to strip from untrusted subprocess output. Ported verbatim from
 *  src/selfhost/ai.ts (`SECRET_PATTERNS`) — keep the two in sync (or shim ai.ts onto this) rather than weakening. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys (sk-..., sk-ant-..., sk-proj-...)
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (header.payload.signature)
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key id
];

/**
 * Redact secrets from untrusted subprocess output before it flows to logs/Sentry: strip each caller-supplied known
 * secret value exactly (length-guarded so a short/empty token can't blank unrelated text), then well-known token
 * shapes ({@link SECRET_PATTERNS}). Ported from src/selfhost/ai.ts's `redactSecrets`. Pure.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
