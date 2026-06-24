// Gittensory Orb (#1255) — central fleet-calibration collector receiver.
// Accepts anonymized, reversal-aware outcome batches from self-hosted instances (exportOrbBatch).
// No raw repo names, owner identifiers, commit SHAs, or PR content — only HMAC-anonymized hashes +
// aggregate calibration metadata (verdict, outcome, reversal, bucketed reason, cycle time).

const MAX_BATCH = 500;
const VALID_OUTCOMES = new Set(["merged", "closed"]);
const VALID_REVERSALS = new Set(["none", "reopened", "reverted"]);
const MIN_CYCLE_MS = 1_000; // <1s is implausible
const MAX_CYCLE_MS = 31_536_000_000; // >1y is implausible

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

  const { instance_id, events } = payload as OrbIngestPayload;
  if (!instance_id || events.length === 0) {
    return { error: "invalid_payload" };
  }

  const batch = events.slice(0, MAX_BATCH);
  let accepted = 0;

  for (const event of batch) {
    if (
      typeof event.repo_hash !== "string" || !event.repo_hash ||
      typeof event.pr_hash !== "string" || !event.pr_hash ||
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
          typeof event.gate_reasoncode_bucket === "string" ? event.gate_reasoncode_bucket : null,
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
