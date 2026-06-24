// Gittensory Orb (#1219) — central collector receiver.
// Accepts anonymized outcome signal batches from self-hosted instances running exportOrbBatch.
// No raw repo names, owner identifiers, or PR content is accepted or stored — only HMAC-anonymized
// hashes + aggregate outcome metadata (verdict, timing).

const MAX_BATCH = 500;
const VALID_OUTCOMES = new Set(["merged", "closed"]);

interface OrbIngestEvent {
  repo_hash: string;
  pr_hash: string;
  outcome: string;
  gate_verdict?: string | null;
  time_to_close_ms?: number | null;
  created_at?: string | null;
}

interface OrbIngestPayload {
  instance_id: string;
  events: OrbIngestEvent[];
}

export type OrbIngestResult = { accepted: number } | { error: string };

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

    try {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO orb_signals
           (instance_id, repo_hash, pr_hash, outcome, gate_verdict, time_to_close_ms, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          instance_id,
          event.repo_hash,
          event.pr_hash,
          event.outcome,
          typeof event.gate_verdict === "string" ? event.gate_verdict : null,
          typeof event.time_to_close_ms === "number" ? event.time_to_close_ms : null,
          typeof event.created_at === "string" ? event.created_at : null,
        )
        .run();
      if (result.meta.changes > 0) accepted++;
    } catch {
      // best-effort — skip rows that violate constraints or hit transient errors
    }
  }

  return { accepted };
}
