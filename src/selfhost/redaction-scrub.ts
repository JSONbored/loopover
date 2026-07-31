// Shared, provider-agnostic redaction primitives (#8287) -- extracted out of src/selfhost/sentry.ts's
// beforeSend scrubber so the PostHog sink (src/selfhost/posthog.ts) can reuse the exact same secret/private-
// text detection without hand-duplicating a security-critical regex set into a second file. This module owns
// only the pure "is this key/value secret-shaped, and how do I redact it" logic; each provider's own
// event-SHAPE orchestration (Sentry's request/contexts/extra/tags/breadcrumbs vs PostHog's flat properties
// bag) stays in that provider's own file, since the two shapes are genuinely different and forcing them
// through one shared walker would make both providers depend on the same brittle shape-guessing.
import {
  PUBLIC_LOCAL_PATH_SCRUB_PATTERN,
  PUBLIC_UNSAFE_TERMS,
} from "../signals/redaction";

export const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;
const PAYLOAD_KEY =
  /(^|[_-])(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content|comment[-_]?text|comment[-_]?body)([_-]|$)|^(body|payload|patch|diff|prompt|rubric|guardrail|headers?|cookies?|title|config|review[-_]?text|review[-_]?content|comment[-_]?text|comment[-_]?body)$/i;
export const SECRET_VALUE = new RegExp(
  [
    `${"github" + "_pat_"}[A-Za-z0-9_]+`,
    String.raw`gh[opsru]_[A-Za-z0-9_]{20,}`,
    String.raw`sk-[A-Za-z0-9_-]{20,}`,
    String.raw`xox[baprs]-[A-Za-z0-9-]+`,
    // LoopOver's own opaque tokens (createOpaqueToken, src/auth/security.ts): gts_ is the default session-token
    // prefix, orbenr_/orbsec_ are the Orb broker's enrollment id/secret (#1825) -- a broker error message can quote
    // these bare (no "secret"/"token"-named field for the key-based redaction below to catch), so the VALUE itself
    // must be recognized here too.
    String.raw`(?:gts|orbenr|orbsec)_[A-Za-z0-9_]{20,}`,
    String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{12,}`,
    String.raw`-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----`,
  ].join("|"),
  "gi",
);
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET_VALUE =
  /([?&;][^=\s&#;]*(?:token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)[^=\s&#;]*=)[^&#\s;]+/gi;
const PRIVATE_TEXT =
  /\b(raw[-_\s]?score|scoring context|private rubric|gate prompt|review prompt|guardrail paths?|pull request body|pr body|pr title|raw diff)\b/gi;
export const PUBLIC_UNSAFE_SCRUB = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b`, "gi");
export const REDACTED = "[redacted]";

/** Low-cardinality operational fields safe to surface as an indexed tag/property on a captured error --
 *  formerly sentry.ts's SENTRY_OPERATIONAL_TAG_KEYS, moved here (2026-07-25 Sentry removal) since posthog.ts
 *  is now this repo's only consumer. */
export const OPERATIONAL_TAG_KEYS = [
  "repo",
  "repository",
  "owner",
  "installation_id_hash",
  "pull",
  "pullNumber",
  "pr",
  "head_sha",
  "project",
  "kind",
  "subsystem",
  "job_type",
  "jobType",
  "reason",
  "result",
  "deliveryId",
  "provider",
  "model",
  "effort",
  "timeoutMs",
  "trace_id",
  "span_id",
  "operation",
  "agent",
  "decision_outcome",
  "event",
  "monitor",
] as const;

export function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type DigestHex = (input: string) => string;
let digestHexSync: DigestHex | undefined;

/** Lazily load a SYNCHRONOUS sha256 hasher (node:crypto's createHash) -- kept out of the module's static
 *  import graph so this module stays safe to import from anywhere (including a Cloudflare Worker bundle)
 *  when the caller never actually invokes {@link installationIdHash}. Mirrors sentry.ts's identical
 *  loadNodeHasher discipline pre-extraction. A sync hasher is required because {@link scrubRecord} walks
 *  its object tree synchronously; the async Web-Crypto-based sha256Hex (src/utils/crypto.ts) can't be
 *  awaited mid-walk without restructuring every caller into an async tree-walk. */
export async function loadNodeHasher(): Promise<void> {
  const { createHash } = await import("node:crypto");
  digestHexSync = (input: string): string => createHash("sha256").update(input).digest("hex");
}

/** Test-only: reset the lazily-loaded hasher between cases. */
export function resetRedactionScrubForTest(): void {
  digestHexSync = undefined;
}

const INSTALLATION_HASH_SEED = "github-installation:";

function normalizeInstallationId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9]+$/.test(trimmed) ? trimmed : undefined;
}

/** Hash a raw installation id into a short, non-reversible tag -- undefined when the hasher hasn't been
 *  loaded yet ({@link loadNodeHasher}) or the value isn't a real installation id. */
function installationIdHash(value: unknown): string | undefined {
  if (!digestHexSync) return undefined;
  const normalized = normalizeInstallationId(value);
  if (!normalized) return undefined;
  return digestHexSync(`${INSTALLATION_HASH_SEED}${normalized}`).slice(0, 16);
}

function isInstallationIdKey(key: string): boolean {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === "installationid";
}

/** Replace a context's raw installation_id/installationId with its hash, matching sentry.ts's
 *  hashedInstallationContext. Returns the input unchanged when there's nothing to hash. */
export function hashedInstallationContext(context: Record<string, unknown>): Record<string, unknown> {
  const hasInstallationId = "installation_id" in context || "installationId" in context;
  const hash = installationIdHash(context.installation_id ?? context.installationId);
  if (!hash && !hasInstallationId) return context;
  const safe: Record<string, unknown> = { ...context };
  if (hash) safe.installation_id_hash = hash;
  delete safe.installation_id;
  delete safe.installationId;
  return safe;
}

function shouldRedactKey(key: string): boolean {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    SECRET_KEY.test(key) ||
    PAYLOAD_KEY.test(key) ||
    /(body|payload|patch|diff|prompt|rubric|guardrail|header|cookie|title|config|reviewtext|reviewcontent|prcontent|pullrequest)/.test(compact)
  );
}

export function scrubString(value: string): string {
  return value
    .replace(QUERY_SECRET_VALUE, `$1${REDACTED}`)
    .replace(SECRET_VALUE, REDACTED)
    .replace(JWT_VALUE, REDACTED)
    .replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>")
    .replace(PUBLIC_UNSAFE_SCRUB, "private context")
    .replace(PRIVATE_TEXT, "private context");
}

function isUrlKey(key: string): boolean {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase().endsWith("url");
}

function isQueryKey(key: string): boolean {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return compact === "query" || compact === "querystring";
}

export function scrubQueryString(value: string): string {
  const hasQuestionMark = value.startsWith("?");
  const source = hasQuestionMark ? value.slice(1) : value;
  const params = new URLSearchParams(source);
  for (const key of Array.from(new Set(params.keys()))) {
    const values = params.getAll(key);
    params.delete(key);
    for (const entry of values) {
      params.append(key, shouldRedactKey(key) ? REDACTED : scrubString(entry));
    }
  }
  const scrubbed = params.toString();
  return hasQuestionMark ? `?${scrubbed}` : scrubbed;
}

export function scrubUrl(value: string): string {
  const scrubbed = scrubString(value);
  const queryStart = scrubbed.indexOf("?");
  if (queryStart === -1) return scrubbed;
  try {
    const parsed = new URL(scrubbed);
    parsed.search = scrubQueryString(parsed.search);
    return parsed.toString();
  } catch {
    return `${scrubbed.slice(0, queryStart + 1)}${scrubQueryString(scrubbed.slice(queryStart + 1))}`;
  }
}

/** #9142: OPERATIONAL_TAG_KEYS are structured identifiers (repo full names, PR/pull numbers, SHAs, model ids,
 *  ...) -- never free text a human wrote. PUBLIC_UNSAFE_SCRUB's bare `\b(reward|score|wallet|hotkey|...)\w*\b`
 *  match and PRIVATE_TEXT's phrase list both assume they're scanning prose; over an identifier like
 *  "ossf/scorecard" (`/` is a non-word char, so `\b` still anchors at the segment start) PUBLIC_UNSAFE_SCRUB
 *  corrupts the very label a reader groups events/metrics by, and two differently-named repos whose second
 *  segment happens to start with the same vocabulary word (scorecard, score-keeper, ...) collapse into one
 *  series once corrupted identically. */
const STRUCTURED_IDENTIFIER_KEYS = new Set<string>(OPERATIONAL_TAG_KEYS);

/** Credential-shape scrubbers ONLY (no vocabulary/phrase matching) -- used for {@link STRUCTURED_IDENTIFIER_KEYS}.
 *  A leaked token/JWT/query secret that landed in an identifier-shaped field by mistake is still a real leak,
 *  so this stays unconditional even for a field whose vocabulary scrubbing is skipped. */
function scrubStructuredIdentifierString(value: string): string {
  return value.replace(QUERY_SECRET_VALUE, `$1${REDACTED}`).replace(SECRET_VALUE, REDACTED).replace(JWT_VALUE, REDACTED);
}

export function scrubStringField(key: string, value: string): string {
  if (isUrlKey(key)) return scrubUrl(value);
  if (isQueryKey(key)) return scrubQueryString(value);
  if (STRUCTURED_IDENTIFIER_KEYS.has(key)) return scrubStructuredIdentifierString(value);
  return scrubString(value);
}

/** Recursively redact secret-shaped keys/values in place, depth-bounded to avoid runaway recursion on a
 *  pathological/cyclic-looking structure. Shared verbatim by both providers' event orchestrators. */
export function scrubRecord(obj: unknown, depth: number): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      if (typeof value === "string") obj[i] = scrubString(value);
      else if (value && typeof value === "object") {
        if (depth >= 6) obj[i] = REDACTED;
        else scrubRecord(value, depth + 1);
      }
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (isInstallationIdKey(key)) {
      const hash = installationIdHash(rec[key]);
      if (hash) rec.installation_id_hash = hash;
      delete rec[key];
      continue;
    }
    // #10211: a secret-shaped KEY holding a NUMBER is a counter, not a credential. Every secret this module
    // exists to catch -- a token, an API key, a password, a cookie, a DSN, a bearer header -- is a string;
    // there is no numeric form of one to leak. Redacting numbers anyway silently destroyed real telemetry:
    // SECRET_KEY matches /token/i, so PostHog's own `$ai_input_tokens`/`$ai_output_tokens` were rewritten to
    // the "[redacted]" STRING, which PostHog then coerced to null on its numerically-typed properties. The
    // result was that not one AI call in the project ever carried a token count, while cost came through
    // untouched (`$ai_total_cost_usd` has no secret-shaped word in it).
    if (shouldRedactKey(key) && typeof rec[key] !== "number") {
      rec[key] = REDACTED;
      continue;
    }
    const value = rec[key];
    if (typeof value === "string") rec[key] = scrubStringField(key, value);
    else if (value && typeof value === "object") {
      if (depth >= 6) rec[key] = REDACTED;
      else scrubRecord(value, depth + 1);
    }
  }
}
