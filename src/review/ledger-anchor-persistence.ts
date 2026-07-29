// Persistence for external decision-ledger anchoring attempts (#9271, epic #9267; migrations/0195). Every
// backend (#9272 Rekor, #9273 git-commit, and any future one) calls ONE recording function whether it
// succeeded or failed -- there is no separate "failure log" a backend could simply not call. That is the
// whole point: per the mechanism research on #9267, an operator whose anchoring silently fails could quietly
// regress the ledger back to tamper-evident-only with no visible signal. A failure recorded exactly like a
// success, on the same public listing, is what makes anchoring's own health itself a publicly checkable fact.
import { nowIso, errorMessage } from "../utils/json";
import type { LedgerAnchorPayload } from "./ledger-anchor";

export type LedgerAnchorBackend = "rekor" | "git" | "ots" | "bittensor";

/** What a backend passes in to record ONE attempt -- success or failure, same shape either way. */
export type LedgerAnchorAttemptInput = {
  payload: LedgerAnchorPayload;
  signature: string;
  keyId: string;
  backend: LedgerAnchorBackend;
} & (
  | { status: "ok"; backendRef: unknown; proofR2Key: string | null }
  | { status: "failed"; error: unknown }
);

/** One row exactly as it will be served publicly -- deliberately the SAME shape whether the attempt
 *  succeeded or failed, so a listing consumer cannot special-case failures into a different, hideable form. */
export type PublicLedgerAnchor = {
  id: string;
  seq: number;
  rowHash: string;
  keyId: string;
  backend: LedgerAnchorBackend;
  backendRef: unknown;
  status: "ok" | "failed";
  error: string | null;
  createdAt: string;
};

/**
 * Record one anchoring attempt. Never throws for the caller's OWN backend failure (that IS what `status:
 * "failed"` records) -- only a genuine local persistence error propagates, matching `appendDecisionLedger`'s
 * posture of letting a storage-layer failure be its own distinct problem rather than silently swallowing it
 * into "the anchor attempt failed" too.
 *
 * `createdAt` is injectable (defaults to `nowIso()`), matching `loadPublicRulePrecision`'s own
 * injectable-clock pattern -- this is NOT `payload.at` (the anchored tip's own captured timestamp, a
 * property of the CHAIN) but "when this attempt was recorded" (a property of THIS row), and the two are
 * naturally different values. Making it injectable is what lets a test control ordering deterministically
 * instead of racing real wall-clock resolution across several inserts in a tight loop.
 */
export async function recordLedgerAnchorAttempt(env: Env, attempt: LedgerAnchorAttemptInput, createdAt: string = nowIso()): Promise<void> {
  const id = crypto.randomUUID();
  const payloadJson = JSON.stringify(attempt.payload);
  const backendRef = attempt.status === "ok" ? JSON.stringify(attempt.backendRef) : null;
  const proofR2Key = attempt.status === "ok" ? attempt.proofR2Key : null;
  // A backend's own error is `unknown`: it may already be a hand-built descriptive string (the common case --
  // "Rekor responded 429: ...") or a genuine thrown Error (a network exception) -- errorMessage() alone only
  // recognizes the latter, collapsing an already-good string to its generic fallback. Use the string as-is;
  // only fall back to errorMessage()'s Error-extraction for anything else.
  const error = attempt.status === "failed" ? (typeof attempt.error === "string" ? attempt.error : errorMessage(attempt.error)).slice(0, 500) : null;

  await env.DB.prepare(
    `INSERT INTO decision_ledger_anchors
       (id, seq, row_hash, payload_json, signature, key_id, backend, backend_ref, proof_r2_key, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      attempt.payload.seq,
      attempt.payload.rowHash,
      payloadJson,
      attempt.signature,
      attempt.keyId,
      attempt.backend,
      backendRef,
      proofR2Key,
      attempt.status,
      error,
      createdAt,
    )
    .run();
}

export type LedgerAnchorListFilter = {
  backend?: LedgerAnchorBackend;
  /** Opaque keyset cursor (a `created_at|id` pair, as returned in a prior page's `nextBefore`): resume strictly
   *  after that exact row in `(created_at DESC, id DESC)` order. Omit for the first (newest) page; an
   *  unparseable value is treated as "no cursor" rather than an error, since this is a public route. */
  before?: string;
  limit?: number;
};

/** Encode a keyset cursor as one opaque string. `created_at` is an ISO timestamp and `id` a UUID, so neither
 *  contains a `|` -- the separator round-trips unambiguously and `parseAnchorCursor` splits on the first `|`. */
function encodeAnchorCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

/** Parse a `created_at|id` cursor. Returns null for a missing or malformed value (no `|`, or an empty
 *  component) so a bad `before` on this unauthenticated public route falls back to the first page, never throws. */
function parseAnchorCursor(before: string | undefined): { createdAt: string; id: string } | null {
  if (!before) return null;
  const separator = before.indexOf("|");
  if (separator <= 0 || separator === before.length - 1) return null;
  return { createdAt: before.slice(0, separator), id: before.slice(separator + 1) };
}

const DEFAULT_ANCHOR_LIST_LIMIT = 50;
const MAX_ANCHOR_LIST_LIMIT = 200;

/**
 * Public, paginated listing -- newest first, success and failure rows returned identically (no filtering out
 * failures, no separate shape). `backendRef`/`error` come back parsed/typed exactly as `PublicLedgerAnchor`
 * declares; a row with unparseable `backend_ref` JSON (never written by `recordLedgerAnchorAttempt` itself,
 * but defensive against any future direct write) degrades to `null` rather than throwing a public endpoint.
 */
export async function loadPublicLedgerAnchors(env: Env, filter: LedgerAnchorListFilter = {}): Promise<{ anchors: PublicLedgerAnchor[]; nextBefore: string | null }> {
  const limit = Math.max(1, Math.min(MAX_ANCHOR_LIST_LIMIT, filter.limit ?? DEFAULT_ANCHOR_LIST_LIMIT));
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.backend) {
    conditions.push("backend = ?");
    binds.push(filter.backend);
  }
  const cursor = parseAnchorCursor(filter.before);
  if (cursor) {
    // Row-comparison keyset predicate matching ORDER BY created_at DESC, id DESC: resume strictly after the
    // cursor row. Filtering on created_at alone (the prior behavior) silently skipped any rows that shared the
    // cursor's created_at but sorted after it on the id tiebreak -- e.g. the several backends written in one
    // scheduler tick at the same millisecond nowIso() (#9715).
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // Fetch one extra row to know whether a next page exists, without a separate COUNT query.
  const rows = await env.DB.prepare(
    `SELECT id, seq, row_hash AS rowHash, key_id AS keyId, backend, backend_ref AS backendRef, status, error, created_at AS createdAt
       FROM decision_ledger_anchors ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{ id: string; seq: number; rowHash: string; keyId: string; backend: LedgerAnchorBackend; backendRef: string | null; status: "ok" | "failed"; error: string | null; createdAt: string }>();

  /* v8 ignore next -- defensive: D1's .all() always returns a results array (even [] for zero rows); the ??
   * guards a driver-shape change, mirroring loadPublicRulePrecision's identical note on COUNT(*). */
  const results = rows.results ?? [];
  const page = results.slice(0, limit);
  // A fetched extra row (results.length > limit) means another page exists; encode BOTH (created_at, id) of the
  // last returned row into the cursor so the next page resumes exactly after it and no created_at tie is skipped
  // (#9715). `> limit` guarantees `page` has exactly `limit` (>=1) elements, so the last element is defined.
  const lastRow = results.length > limit ? page[page.length - 1] : undefined;
  const nextBefore = lastRow ? encodeAnchorCursor(lastRow.createdAt, lastRow.id) : null;

  const anchors: PublicLedgerAnchor[] = page.map((row) => ({
    id: row.id,
    seq: row.seq,
    rowHash: row.rowHash,
    keyId: row.keyId,
    backend: row.backend,
    backendRef: parseBackendRef(row.backendRef),
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
  }));

  return { anchors, nextBefore };
}

function parseBackendRef(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The most recent anchor ATTEMPT, regardless of backend or status -- the reference point the scheduler
 * (#9274) compares the live tip against. Deliberately not "the most recent SUCCESSFUL anchor": if a backend
 * is down for a stretch, treating each failed retry as if nothing had been attempted would mean hammering the
 * same stale checkpoint every cron tick against a backend that keeps failing, rather than advancing to a
 * newer tip as time passes and letting the gap be visible on #9271's own public attempt log. Returns null
 * only when nothing has ever been recorded (the very first anchor ever).
 */
export async function loadLastLedgerAnchorAttempt(env: Env): Promise<{ seq: number; rowHash: string } | null> {
  const row = await env.DB.prepare("SELECT seq, row_hash AS rowHash FROM decision_ledger_anchors ORDER BY created_at DESC, id DESC LIMIT 1").first<{
    seq: number;
    rowHash: string;
  }>();
  return row == null ? null : row;
}

/**
 * #9489: does the CURRENT tip still lack a successful anchor?
 *
 * {@link loadLastLedgerAnchorAttempt} deliberately returns the newest attempt regardless of status, so the
 * scheduler advances to newer tips rather than hammering a stale checkpoint. But that made a failed attempt at
 * a QUIET tip unrecoverable: Rekor 429s at seq N, the ledger goes quiet (a weekend), every hourly tick then
 * sees `tipUnchanged` and returns "unchanged" -- so the tip carries NO valid external anchor indefinitely,
 * which is precisely the unanchored window the feature exists to bound.
 *
 * It is also backend-blind: git succeeding at seq N masked rekor failing at the same seq, because the newest
 * attempt row won regardless of which backend wrote it. Asking per-backend "is there an OK row for this exact
 * rowHash" answers both.
 */
export async function anchorBackendsMissingForRowHash(env: Env, rowHash: string, backends: readonly string[]): Promise<string[]> {
  if (backends.length === 0) return [];
  const placeholders = backends.map((_, index) => `?${index + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT backend FROM decision_ledger_anchors WHERE row_hash = ?1 AND status = 'ok' AND backend IN (${placeholders})`,
  )
    .bind(rowHash, ...backends)
    .all<{ backend: string }>();
  const anchored = new Set(results.map((row) => row.backend));
  return backends.filter((backend) => !anchored.has(backend));
}
