// Persistence for external decision-ledger anchoring attempts (#9271, epic #9267; migrations/0195). Every
// backend (#9272 Rekor, #9273 git-commit, and any future one) calls ONE recording function whether it
// succeeded or failed -- there is no separate "failure log" a backend could simply not call. That is the
// whole point: per the mechanism research on #9267, an operator whose anchoring silently fails could quietly
// regress the ledger back to tamper-evident-only with no visible signal. A failure recorded exactly like a
// success, on the same public listing, is what makes anchoring's own health itself a publicly checkable fact.
import { nowIso, errorMessage } from "../utils/json";
import type { LedgerAnchorPayload } from "./ledger-anchor";

export type LedgerAnchorBackend = "rekor" | "git" | "ots";

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
  const error = attempt.status === "failed" ? errorMessage(attempt.error).slice(0, 500) : null;

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
  /** Cursor: return rows strictly older than this ISO timestamp. Omit for the first (newest) page. */
  before?: string;
  limit?: number;
};

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
  if (filter.before) {
    conditions.push("created_at < ?");
    binds.push(filter.before);
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
  // `> limit` guarantees `page` has exactly `limit` (>=1) elements, so `page[page.length - 1]` is always
  /* v8 ignore next -- defined; the ?. only guards TypeScript's array-index type, not a reachable runtime case. */
  const nextBefore = results.length > limit ? (page[page.length - 1]?.createdAt ?? null) : null;

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
