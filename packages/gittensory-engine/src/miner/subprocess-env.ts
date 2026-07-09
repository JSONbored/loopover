// Shared subprocess env-allowlist + secret-redaction helper (#4284). Engine-hosted so every
// subprocess-spawning driver in gittensory-miner (and src/selfhost/ai.ts's subscription-CLI path)
// can depend on one source of truth instead of copy-pasting the pattern.
//
// Generalized from the subscription-CLI code in src/selfhost/ai.ts: `buildAllowlistedEnv` parameterizes
// the allowlist (a coding-agent subprocess may need a different/larger allowlist than a review-only CLI
// call), and `redactSubprocessSecrets` carries over `redactSecrets`'s known-value + token-shape stripping
// with the same `SECRET_PATTERNS` regex family (ported, not weakened).
//
// MIGRATION (#4284, deliberate): src/selfhost/ai.ts KEEPS its own copy for now — this change makes no
// behavioral edit to the hosted review path. This module is the shared source of truth for NEW
// subprocess drivers; refactoring ai.ts onto it (the shim pattern src/rules/predicted-gate.ts uses over
// the engine) is deferred to a follow-up to avoid churning the hosted path in this PR.
//
// Pure: no IO, no Date.now(), no randomness.

/** Well-known secret shapes to strip from untrusted subprocess output. Ported verbatim from
 *  src/selfhost/ai.ts's SECRET_PATTERNS so the two stay coverage-equivalent (OpenAI/Anthropic keys,
 *  GitHub tokens, fine-grained PATs, JWTs, AWS access-key ids). */
export const SUBPROCESS_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys (sk-..., sk-ant-..., sk-proj-...)
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (header.payload.signature)
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key id
];

/** The subscription-CLI review allowlist (src/selfhost/ai.ts) exported as a ready default for review-only
 *  CLI calls. Other drivers should pass their OWN allowlist to `buildAllowlistedEnv` rather than reuse this. */
export const SUBSCRIPTION_CLI_ENV_ALLOWLIST: readonly string[] = [
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
];

/**
 * Build a strict allowlisted child environment: only keys named in `allowlist` are carried over from
 * `parent`, then `extra` is layered on top. Keys with an `undefined` value (in either source) are omitted
 * so the child never gains an empty var it wouldn't otherwise have. Pure — mirrors `subscriptionCliEnv`'s
 * allowlist copy, minus the subscription-CLI-specific PATH rewrite (a caller that needs that composes it).
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

/**
 * Redact secrets from untrusted subprocess output before it enters an error message / log line: strip the
 * caller's known secret VALUES exactly (length-guarded so a short/empty token can't blank unrelated text),
 * then well-known token SHAPES from {@link SUBPROCESS_SECRET_PATTERNS}. Pure. Ported from
 * src/selfhost/ai.ts's `redactSecrets`.
 */
export function redactSubprocessSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    // Length-guard so a short/empty token (e.g. a stubbed "t") can't blank out unrelated diagnostic text.
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SUBPROCESS_SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
