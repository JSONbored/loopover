// Gittensory AMS (#5681) — central telemetry collector receiver, mirroring Orb's own (`src/orb/ingest.ts`)
// registration-gate + best-effort-upsert pattern. Accepts anonymized PR-outcome batches from opt-in AMS
// instances (packages/gittensory-miner/lib/orb-export.js). No raw repo names, owner identifiers, or PR
// content — only HMAC-anonymized hashes + a decision + a low-cardinality reason bucket.

const MAX_BATCH = 500;
const MAX_INSTANCE_ID_CHARS = 64;
const MAX_HASH_CHARS = 128;
const MAX_BUCKET_CHARS = 64;
const VALID_DECISIONS = new Set(["merged", "closed"]);

interface AmsIngestEvent {
  repoHash: string;
  prHash: string;
  decision: string;
  reasonBucket?: string | null;
  closedAt?: string | null;
}

interface AmsIngestPayload {
  instanceId: string;
  events: AmsIngestEvent[];
}

export type AmsIngestResult = { accepted: number } | { error: string };

export async function handleAmsIngest(body: string, db: D1Database): Promise<AmsIngestResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { error: "invalid_json" };
  }

  if (
    typeof (payload as AmsIngestPayload)?.instanceId !== "string" ||
    !Array.isArray((payload as AmsIngestPayload)?.events)
  ) {
    return { error: "invalid_payload" };
  }

  const { instanceId, events } = payload as AmsIngestPayload;
  if (!instanceId || instanceId.length > MAX_INSTANCE_ID_CHARS || events.length === 0) {
    return { error: "invalid_payload" };
  }

  // Record the instance on first contact (registered=0 by default) and bump last_seen — same trust anchor
  // Orb's orb_instances uses: every source is seen, but nothing counts toward a fleet-wide aggregate until
  // an operator opts it in.
  try {
    await db
      .prepare(`INSERT INTO ams_instances (instance_id) VALUES (?) ON CONFLICT(instance_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`)
      .bind(instanceId)
      .run();
  } catch {
    // best-effort: never fail ingest because the instance bookkeeping hiccupped
  }

  const batch = events.slice(0, MAX_BATCH);
  let accepted = 0;

  for (const event of batch) {
    if (
      typeof event.repoHash !== "string" || !event.repoHash || event.repoHash.length > MAX_HASH_CHARS ||
      typeof event.prHash !== "string" || !event.prHash || event.prHash.length > MAX_HASH_CHARS ||
      !VALID_DECISIONS.has(event.decision)
    ) {
      continue;
    }

    try {
      // OR REPLACE: a re-exported PR (e.g. a decision that changed) upserts the freshest outcome on the
      // (instance_id, pr_hash) dedup key.
      const result = await db
        .prepare(
          `INSERT OR REPLACE INTO ams_signals
           (instance_id, repo_hash, pr_hash, decision, reason_bucket, closed_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        )
        .bind(
          instanceId,
          event.repoHash,
          event.prHash,
          event.decision,
          typeof event.reasonBucket === "string" && event.reasonBucket.length <= MAX_BUCKET_CHARS ? event.reasonBucket : null,
          typeof event.closedAt === "string" ? event.closedAt : null,
        )
        .run();
      if (result.meta.changes > 0) accepted++;
    } catch {
      // best-effort — skip rows that violate constraints or hit transient errors
    }
  }

  return { accepted };
}
