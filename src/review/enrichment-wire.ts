// Convergence (review-enrichment) wiring: feeds the AI reviewer a pre-rendered "review brief" from the external
// Review-Enrichment Service (REES) so the no-checkout `claude --print` reviewer — which runs with
// `Bash/Edit/Write/WebFetch/WebSearch` disallowed and has NO repo checkout — can splice in heavy/external/
// historical analysis it is blind to (dependency/CVE #1474, license #1475, secret #1476, static+complexity #1477,
// history #1478). REES is a STANDALONE microservice; this module is the ENGINE-side seam that POSTs the PR's
// diff + files + short-lived broker token and returns `{ promptSection, systemSuffix }` to splice into the prompt
// alongside grounding + RAG. Fully fail-safe: any timeout / non-200 / parse error returns the EMPTY constant and
// the review proceeds on the diff alone. This module NEVER throws.
//
// Single env switch: GITTENSORY_REVIEW_ENRICHMENT. Default OFF (unset/"false") — when OFF this module is never
// invoked from the review path (the caller guards on the flag), gathers nothing, makes NO POST, and the reviewer
// prompt is byte-identical to today. Truthy follows the codebase convention
// (`/^(1|true|yes|on)$/i`, same as isGroundingEnabled / isRagEnabled / isSafetyEnabled / isEnabled).
//
// Required co-config (READ but not validated for shape — operators set these in `.dev.vars` / `wrangler secret put`):
//   REES_URL             — base URL of REES (e.g. `http://rees.railway.internal:8080`); no trailing slash.
//   REES_SHARED_SECRET   — bearer shared-secret; sent as `Authorization: Bearer <secret>`. The matching
//                          `REES_SHARED_SECRET` lives on the REES side (review-enrichment/README.md).
//   REES_TIMEOUT_MS      — per-call timeout in ms; default 8000 (REES analyzers are bounded, a stuck worker
//                          must not stall the review path — mirrors the grounding file-fetch discipline).
// Missing URL OR secret ⇒ the seam short-circuits to EMPTY with no fetch — the engine behaves byte-identical
// to flag-OFF. This is intentional: a partially-configured deploy is treated as OFF.
//
// The brief is ADDITIVE prompt context, not a gate finding. Whatever the model echoes is still subject to the
// existing `sanitizePublicComment` / `toPublicSafe` filters on the way out — no public-surface change.
// No DB write, no migration. The REES service itself + the individual analyzers (#1474-#1478) live in
// separate follow-up issues (#1485 scaffolded the hono server / bearer auth; analyzers land behind the stable
// `EnrichRequest` / `ReviewBrief` contract).

/** True when the enrichment seam is enabled. Flag-OFF (default) ⇒ the caller takes no new branch, no POST is
 *  made, and the reviewer prompt stays byte-identical. */
export function isEnrichmentEnabled(env: { GITTENSORY_REVIEW_ENRICHMENT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_ENRICHMENT ?? "");
}

/** Default per-call timeout. REES analyzers are bounded (#1474-#1478) but a stuck worker must not stall the
 *  review path — 8s mirrors the grounding file-fetch timeout band. Callers may override via `REES_TIMEOUT_MS`. */
const DEFAULT_REES_TIMEOUT_MS = 8000;

/** EMPTY result — returned when the flag is OFF, the seam is not configured, or the REES call fails for ANY
 *  reason (timeout, non-200, parse error). The caller splices `promptSection` / `systemSuffix` into the AI
 *  reviewer prompts and skips the splice when both fields are "" (byte-identical to today). PURE. */
export const EMPTY_ENRICHMENT: EnrichmentBrief = { promptSection: "", systemSuffix: "" };

/** The review-enrichment brief block the engine splices into the reviewer prompts. Both fields are "" when the
 *  seam is OFF / unconfigured / failed — so the caller's prompt is byte-identical to today. Mirrors
 *  `ReviewGroundingText` in `grounding-wire.ts`. */
export type EnrichmentBrief = {
  /** Appended to the reviewer's USER prompt — the REES-rendered RELEVANT BRIEF block (CVE/license/secret/
   *  static/history findings). "" when off/unconfigured/failed. */
  promptSection: string;
  /** Appended to the reviewer's SYSTEM prompt — the enrichment-discipline rules the model follows. "" when
   *  off/unconfigured/failed. */
  systemSuffix: string;
};

/** Engine → REES request. Mirrors `EnrichRequest` in `review-enrichment/src/server.ts` — the wire shape is the
 *  source of truth on the service side; this is the engine-side mirror. The `githubToken` is a short-lived
 *  broker token so REES can hit OSV/license/history without re-minting app credentials; never logged. */
export type EnrichmentRequest = {
  repoFullName: string;
  prNumber: number;
  headSha?: string | undefined;
  baseSha?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  author?: string | undefined;
  linkedIssue?: { number: number; url?: string; title?: string };
  files?: Array<{
    path: string;
    status?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
  }>;
  diff?: string;
  /** Short-lived broker token for OSV/license/history fetches. Never logged. */
  githubToken?: string;
  budget?: { timeoutMs?: number; maxBriefChars?: number };
  analyzers?: string[];
};

/** Service → engine response. Mirrors `ReviewBrief` in `review-enrichment/src/server.ts`. The engine reads only
 *  `promptSection` + `systemSuffix` for splicing — `findings` and `analyzerStatus` are kept in the response
 *  shape for parity with the service contract but are not surfaced. */
export type ReviewBriefResponse = {
  schemaVersion: number;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  generatedAtIso: string;
  elapsedMs: number;
  partial: boolean;
  analyzerStatus: Record<string, "ok" | "degraded" | "skipped">;
  findings: Record<string, unknown>;
  promptSection: string;
  systemSuffix: string;
};

function reesTimeoutMs(env: { REES_TIMEOUT_MS?: string | undefined }): number {
  const raw = Number(env.REES_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REES_TIMEOUT_MS;
  // Clamp to a sane upper bound so a misconfigured 10-hour timeout cannot stall the worker indefinitely.
  return Math.max(1, Math.min(raw, 60_000));
}

/** Subset of `Env` the seam reads. Operators set `REES_URL` + `REES_SHARED_SECRET` in `.dev.vars` /
 *  `wrangler secret put`; the seam short-circuits to EMPTY if either is absent. `REES_TIMEOUT_MS` is
 *  optional (default 8000ms). */
export interface EnrichmentEnvShape {
  GITTENSORY_REVIEW_ENRICHMENT?: string;
  REES_URL?: string;
  REES_SHARED_SECRET?: string;
  REES_TIMEOUT_MS?: string;
}

/**
 * Call REES and return the brief block to splice into the reviewer prompts. When the flag is OFF or the
 * service URL/secret is missing this returns `EMPTY_ENRICHMENT` WITHOUT making a POST — the caller's prompt
 * is byte-identical to the flag-OFF path. When ON, it POSTs the request, validates the response, and returns
 * the `promptSection` + `systemSuffix` to splice. Any error (timeout, non-200, parse error) degrades to
 * `EMPTY_ENRICHMENT` and emits one structured `selfhost_enrichment_failed` warn log so the failure mode is
 * observable without scraping the brief body. This NEVER throws.
 *
 * `fetchImpl` defaults to the global `fetch` (Workers + Node 18+). Tests pass a stub to inject canned responses.
 */
export async function buildReviewEnrichment(
  env: EnrichmentEnvShape,
  args: EnrichmentRequest,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<EnrichmentBrief> {
  if (!isEnrichmentEnabled(env)) return EMPTY_ENRICHMENT;
  const url = env.REES_URL;
  const secret = env.REES_SHARED_SECRET;
  // Missing URL OR secret ⇒ partially-configured deploy; treat as OFF. Deliberately do NOT log this — a
  // missing-config deploy is a misconfiguration, not a transient enrichment failure (and spamming the log
  // on every PR would be noisy).
  if (!url || !secret) return EMPTY_ENRICHMENT;
  const f = options.fetchImpl ?? fetch;
  const timeoutMs = reesTimeoutMs(env);
  try {
    const response = await f(`${url.replace(/\/+$/, "")}/v1/enrich`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "user-agent": "gittensory/0.1",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "selfhost_enrichment_failed",
          reason: "http_status",
          status: response.status,
          repo: args.repoFullName,
          prNumber: args.prNumber,
        }),
      );
      return EMPTY_ENRICHMENT;
    }
    let brief: ReviewBriefResponse;
    try {
      brief = (await response.json()) as ReviewBriefResponse;
    } catch {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "selfhost_enrichment_failed",
          reason: "parse",
          repo: args.repoFullName,
          prNumber: args.prNumber,
        }),
      );
      return EMPTY_ENRICHMENT;
    }
    if (!brief || typeof brief !== "object") return EMPTY_ENRICHMENT;
    return {
      promptSection: typeof brief.promptSection === "string" ? brief.promptSection : "",
      systemSuffix: typeof brief.systemSuffix === "string" ? brief.systemSuffix : "",
    };
  } catch {
    // Covers network errors, AbortSignal.timeout, and any other thrown rejection. One log line per failure
    // so Loki can correlate the spike with the underlying cause; the brief is empty, the review proceeds.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "selfhost_enrichment_failed",
        reason: "network_or_timeout",
        repo: args.repoFullName,
        prNumber: args.prNumber,
      }),
    );
    return EMPTY_ENRICHMENT;
  }
}
