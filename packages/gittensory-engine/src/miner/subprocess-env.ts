// Shared subprocess env-allowlist + secret redaction (#4284): pure, engine-hosted helpers so every
// subprocess-spawning driver (the CLI-subprocess CodingAgentDriver #4266, and anything else in
// gittensory-miner) depends on ONE source of truth instead of copy-pasting the pattern from
// `src/selfhost/ai.ts`. Strings/objects only — no IO, no `process.env` read, no spawning.
//
// Generalized from `src/selfhost/ai.ts`'s `SUBSCRIPTION_CLI_ENV_ALLOWLIST`/`subscriptionCliEnv` (:349-411),
// `SECRET_PATTERNS` (:719-725) and `redactSecrets` (:724-731): the allowlist is a PARAMETER here (a
// coding-agent subprocess may need a different/larger allowlist than a review-only CLI call), and the
// redactor carries over the same secret-shape family verbatim. The CLI-specific PATH synthesis
// (`resolveSubscriptionCliPath`) stays in `ai.ts` — it is not part of this generalized allowlist builder;
// PATH here is treated like any other allowlisted/overridable key.
//
// MIGRATION (deliberate, documented choice per #4284): `src/selfhost/ai.ts` KEEPS its existing parallel copy
// for now — this module is the shared source of truth for NEW engine/miner subprocess code. A follow-up may
// shim `ai.ts` onto it (mirroring the `src/rules/predicted-gate.ts` → engine `predicted-gate.ts` shim). Left a
// parallel copy rather than refactoring `ai.ts` in this PR to keep the change self-contained to the engine.

/** Well-known secret shapes to redact from untrusted subprocess output before it reaches logs/errors.
 *  Carried over verbatim from `src/selfhost/ai.ts`'s `SECRET_PATTERNS`. */
export const SUBPROCESS_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys (sk-..., sk-ant-..., sk-proj-...)
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (header.payload.signature)
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key id
];

/** A conservative default env allowlist for a locally-authenticated CLI subprocess — the CLI-auth / home /
 *  proxy / cert vocabulary from `src/selfhost/ai.ts`'s `SUBSCRIPTION_CLI_ENV_ALLOWLIST`. Callers pass their
 *  own when they need a different set (e.g. a coding-agent subprocess needing a larger allowlist). */
export const DEFAULT_SUBPROCESS_ENV_ALLOWLIST: readonly string[] = [
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

export type BuildAllowlistedEnvOptions = {
  /** Keys to carry from the parent env. Defaults to {@link DEFAULT_SUBPROCESS_ENV_ALLOWLIST}. */
  allowlist?: readonly string[];
  /** Extra vars overlaid after the allowlist (defined values win; `undefined` values are skipped). */
  extra?: Record<string, string | undefined>;
};

/**
 * Build a child-process env from `parent`, keeping ONLY the allowlisted keys that have a defined value, then
 * overlaying `extra` (defined values win). This is the "strict allowlisted env, not the whole parent env"
 * discipline from `subscriptionCliEnv` — credentials outside the allowlist never reach the subprocess. Pure:
 * reads nothing external, mutates nothing, returns a new object.
 */
export function buildAllowlistedEnv(
  parent: Record<string, string | undefined>,
  options: BuildAllowlistedEnvOptions = {},
): Record<string, string> {
  const allowlist = options.allowlist ?? DEFAULT_SUBPROCESS_ENV_ALLOWLIST;
  const child: Record<string, string> = {};
  for (const key of allowlist) {
    const value = parent[key];
    if (value !== undefined) child[key] = value;
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined) child[key] = value;
  }
  return child;
}

/**
 * Redact secrets from untrusted text before it enters a log/error string. Strips the caller's known secret
 * values exactly (length-guarded at ≥8 so a short/empty token can't blank unrelated text), then well-known
 * token shapes from {@link SUBPROCESS_SECRET_PATTERNS}. Pure. Ported from `redactSecrets`.
 */
export function redactSubprocessSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SUBPROCESS_SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
