// LoopOver Orb (#1255) — central fleet-calibration collector receiver.
// Accepts anonymized, reversal-aware outcome batches from self-hosted instances (exportOrbBatch).
// No raw repo names, owner identifiers, commit SHAs, or PR content — only HMAC-anonymized hashes +
// aggregate calibration metadata (verdict, outcome, reversal, bucketed reason, cycle time).

const MAX_BATCH = 500;
const MAX_INSTANCE_ID_CHARS = 64;
const MAX_HASH_CHARS = 128;
const MAX_BUCKET_CHARS = 64;
const VALID_OUTCOMES = new Set(["merged", "closed"]);
const VALID_REVERSALS = new Set(["none", "reopened", "reverted"]);
const MIN_CYCLE_MS = 1_000; // <1s is implausible
const MAX_CYCLE_MS = 31_536_000_000; // >1y is implausible

// 1 MiB comfortably holds a full MAX_BATCH (500) of small anonymized events (~hashes + numbers) with
// headroom, while bounding how much a hostile sender can make the collector buffer. Mirrors the
// body limit das-github-mirror puts in front of its open webhook ingress.
export const MAX_ORB_INGEST_BODY_BYTES = 1_048_576;

function parseContentLength(header: string | null | undefined): number | null {
  if (typeof header !== "string") return null;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Read the request body with a hard byte ceiling so a hostile sender can't make us buffer unbounded
 *  input. Returns null when the body exceeds MAX_ORB_INGEST_BODY_BYTES (the caller answers 413). */
export async function readOrbIngestBody(request: Request, contentLengthHeader: string | null | undefined): Promise<string | null> {
  const declared = parseContentLength(contentLengthHeader);
  if (declared !== null && declared > MAX_ORB_INGEST_BODY_BYTES) return null;

  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ORB_INGEST_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

interface OrbIngestEvent {
  repo_hash: string;
  pr_hash: string;
  gate_verdict?: string | null;
  outcome: string;
  reversal_flag?: string | null;
  gate_reasoncode_bucket?: string | null;
  time_to_close_ms?: number | null;
  decision_timestamp?: string | null;
  outcome_timestamp?: string | null;
}

interface OrbIngestPayload {
  instance_id: string;
  events: OrbIngestEvent[];
  // #4933: optional -- an older self-host build that hasn't upgraded yet simply omits this, and the
  // instance's stored health stays whatever it last was (or NULL/unknown on first contact).
  health?: { ok: boolean };
}

export type OrbIngestResult = { accepted: number } | { error: string };

/** Clamp a sender-supplied cycle time to a plausible range; null for anything implausible/absent. */
function clampCycleMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_CYCLE_MS || value > MAX_CYCLE_MS) return null;
  return Math.round(value);
}

export async function handleOrbIngest(body: string, db: D1Database): Promise<OrbIngestResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { error: "invalid_json" };
  }

  if (
    typeof (payload as OrbIngestPayload)?.instance_id !== "string" ||
    !Array.isArray((payload as OrbIngestPayload)?.events)
  ) {
    return { error: "invalid_payload" };
  }

  const { instance_id, events, health } = payload as OrbIngestPayload;
  // #4933: a `health` key that IS present must be well-formed, whether or not `events` also carries real
  // outcome rows -- rejecting only when events is also empty would silently drop a malformed health report
  // from a sender that also has real events to export, instead of surfacing the sender's bug. An ABSENT
  // health key (an older self-host build that doesn't send this field yet) is fine and falls through as
  // healthy = null, exactly as before this field existed.
  let healthy: number | null = null;
  if (health !== undefined) {
    if (typeof health !== "object" || health === null || typeof health.ok !== "boolean") {
      return { error: "invalid_payload" };
    }
    healthy = health.ok ? 1 : 0;
  }
  // An empty batch is only valid when it's carrying a (well-formed) health-only ping (the hourly export
  // still has to report health even in a tick with nothing new to export) -- a truly empty, health-less
  // payload stays rejected exactly as before #4933.
  if (!instance_id || instance_id.length > MAX_INSTANCE_ID_CHARS || (events.length === 0 && healthy === null)) {
    return { error: "invalid_payload" };
  }
  const healthReportedAt = healthy === null ? null : new Date().toISOString();

  // Record the instance on first contact (registered=0 by default) and bump last_seen. The registration
  // gate lives in computeFleetAnalytics: signals are stored for everyone, but only registered instances
  // count toward the fleet median — so open ingest can't be used to skew calibration (the das-github-mirror
  // model: every source is seen, trusted only once an operator opts it in).
  //
  // healthy/health_reported_at only move when THIS payload actually reported a health status (COALESCE
  // falls back to whatever was already stored) -- an outcome-only ingest from a self-host build that
  // hasn't upgraded to send health yet must never silently overwrite a real prior health reading with
  // NULL, and must never look "healthy" just because the instance is otherwise active.
  try {
    await db
      .prepare(
        `INSERT INTO orb_instances (instance_id, healthy, health_reported_at) VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           last_seen_at = CURRENT_TIMESTAMP,
           healthy = COALESCE(excluded.healthy, orb_instances.healthy),
           health_reported_at = COALESCE(excluded.health_reported_at, orb_instances.health_reported_at)`,
      )
      .bind(instance_id, healthy, healthReportedAt)
      .run();
  } catch {
    // best-effort: never fail ingest because the instance bookkeeping hiccupped
  }

  const batch = events.slice(0, MAX_BATCH);
  let accepted = 0;

  for (const event of batch) {
    if (
      typeof event.repo_hash !== "string" || !event.repo_hash || event.repo_hash.length > MAX_HASH_CHARS ||
      typeof event.pr_hash !== "string" || !event.pr_hash || event.pr_hash.length > MAX_HASH_CHARS ||
      !VALID_OUTCOMES.has(event.outcome)
    ) {
      continue;
    }

    // Untrusted-input normalization: whitelist reversal_flag, clamp cycle time, coerce the rest to null.
    const reversal = typeof event.reversal_flag === "string" && VALID_REVERSALS.has(event.reversal_flag) ? event.reversal_flag : "none";

    try {
      // OR REPLACE: a re-exported PR (e.g. one that later gained a reversal) upserts the freshest outcome
      // on the (instance_id, repo_hash, pr_hash) dedup key.
      const result = await db
        .prepare(
          `INSERT OR REPLACE INTO orb_signals
           (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket,
            time_to_close_ms, decision_timestamp, outcome_timestamp, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          instance_id,
          event.repo_hash,
          event.pr_hash,
          typeof event.gate_verdict === "string" ? event.gate_verdict : null,
          event.outcome,
          reversal,
          typeof event.gate_reasoncode_bucket === "string" && event.gate_reasoncode_bucket.length <= MAX_BUCKET_CHARS ? event.gate_reasoncode_bucket : null,
          clampCycleMs(event.time_to_close_ms),
          typeof event.decision_timestamp === "string" ? event.decision_timestamp : null,
          typeof event.outcome_timestamp === "string" ? event.outcome_timestamp : null,
          typeof event.outcome_timestamp === "string" ? event.outcome_timestamp : null,
        )
        .run();
      if (result.meta.changes > 0) accepted++;
    } catch {
      // best-effort — skip rows that violate constraints or hit transient errors
    }
  }

  return { accepted };
}
