// Gittensory Orb (#1255) — fleet calibration EXPORTER. Each self-hosted instance already records de-noised
// ground truth in review_audit (gate_decision + pr_outcome + reversal_reopened/reversal_reverted) via the
// engine's outcomes-wire. This ships an anonymized, reversal-aware signal UP to gittensory's central
// collector so the gate can be calibrated across the whole self-host fleet.
//
//   ORB_ENABLED=true          — activates export (off by default)
//   ORB_COLLECTOR_URL=<url>   — endpoint (default: gittensory's hosted collector)
//   ORB_AIR_GAP=true          — keep everything local, never send externally
//   ORB_ANONYMIZE=true        — HMAC-hash repo/PR before export (default: true)
//
// No diffs, no code, no comments, no logins, no commit SHAs — only verdict + outcome + reversal + a bucketed
// reason category + cycle time, with repo/PR identifiers HMAC'd by THIS instance's own secret (the collector
// holds no instance secret, so it can never de-anonymize).
import { createHash, createHmac } from "node:crypto";
import { incr } from "./metrics";

/** One de-noised, resolved-PR row read from review_audit (the join below). */
interface FleetRow {
  project: string; // repo full name (review_audit.project)
  target_id: string; // `repo#pr`
  verdict: string | null; // gate_decision.decision: merge | close | hold
  reasoncode: string | null; // gate_decision.summary (raw — bucketed before export)
  decided_at: string; // gate_decision.created_at — non-null (NOT NULL column + inner join)
  outcome: string; // pr_outcome.decision: merged | closed
  outcome_at: string;
  reverted: number; // 0|1
  reopened: number; // 0|1
  event_at: string; // max(outcome_at, latest reversal time) — the export watermark unit
}

interface FleetEvent {
  repo_hash: string;
  pr_hash: string;
  gate_verdict: string | null;
  outcome: string;
  reversal_flag: "none" | "reopened" | "reverted";
  gate_reasoncode_bucket: string;
  time_to_close_ms: number | null;
  decision_timestamp: string | null;
  outcome_timestamp: string;
}

interface OrbExportPayload {
  instance_id: string;
  events: FleetEvent[];
}

/** Stable instance identifier (hash of the Orb/App ID — no PII). */
function instanceId(): string {
  return createHash("sha256").update(process.env.ORB_APP_ID ?? process.env.GITHUB_APP_ID ?? "unknown").digest("hex").slice(0, 16);
}

/** HMAC a string with the instance's own secret for anonymized export. */
function hmacField(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}

/** Map the gate's free-text reasonCode to a fixed, low-cardinality category — done at the source so the raw
 *  (possibly repo-specific) reason string never leaves the instance. */
export function bucketReasonCode(summary: string | null | undefined): string {
  if (!summary) return "none";
  const s = summary.toLowerCase();
  if (s.includes("linked_issue") || s.includes("linked issue")) return "issue_policy";
  if (s.includes("duplicate")) return "duplicate_risk";
  if (s.includes("slop")) return "slop_advisory";
  if (s.includes("ai_review") || s.includes("ai_consensus") || s.includes("consensus")) return "ai_quality";
  if (s.includes("self_authored") || s.includes("author") || s.includes("maintainer_cut")) return "author_policy";
  if (s.includes("ci_") || s.includes("ci state") || s.includes("ci passed")) return "ci_readiness";
  return "other";
}

/** Returns true only when Orb export is explicitly enabled. */
export function orbEnabled(): boolean {
  const v = (process.env.ORB_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

// Latest gate_decision + latest pr_outcome per target_id, plus any reversal — portable (window functions +
// CASE, no SQLite-only bare-column-with-MAX) so it runs on the self-host SQLite OR Postgres backend.
const FLEET_QUERY = `
  WITH gd AS (
    SELECT target_id, project, decision AS verdict, summary AS reasoncode, created_at AS decided_at,
           ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
    FROM review_audit
    WHERE event_type = 'gate_decision' AND decision IS NOT NULL AND source = 'gittensory-native'
  ),
  po AS (
    SELECT target_id, decision AS outcome, created_at AS outcome_at,
           ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS rn
    FROM review_audit
    WHERE event_type = 'pr_outcome' AND decision IS NOT NULL
  ),
  rev AS (
    SELECT target_id,
      MAX(CASE WHEN event_type = 'reversal_reverted' THEN 1 ELSE 0 END) AS reverted,
      MAX(CASE WHEN event_type = 'reversal_reopened' THEN 1 ELSE 0 END) AS reopened,
      MAX(created_at) AS rev_at
    FROM review_audit
    WHERE event_type IN ('reversal_reverted', 'reversal_reopened')
    GROUP BY target_id
  )
  SELECT project, target_id, verdict, reasoncode, decided_at, outcome, outcome_at, reverted, reopened, event_at
  FROM (
    SELECT gd.project AS project, gd.target_id AS target_id, gd.verdict AS verdict, gd.reasoncode AS reasoncode,
           gd.decided_at AS decided_at, po.outcome AS outcome, po.outcome_at AS outcome_at,
           COALESCE(rev.reverted, 0) AS reverted, COALESCE(rev.reopened, 0) AS reopened,
           CASE WHEN rev.rev_at IS NOT NULL AND rev.rev_at > po.outcome_at THEN rev.rev_at ELSE po.outcome_at END AS event_at
    FROM gd
    JOIN po ON gd.target_id = po.target_id
    LEFT JOIN rev ON gd.target_id = rev.target_id
    WHERE gd.rn = 1 AND po.rn = 1
  ) AS resolved
  WHERE event_at > ?
  ORDER BY event_at
  LIMIT ?`;

/** ms between the gate decision and the resolution; null if implausible (NaN or negative). */
function cycleTimeMs(decidedAt: string, outcomeAt: string): number | null {
  const ms = new Date(outcomeAt).getTime() - new Date(decidedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Export newly-resolved PR outcomes (since this instance's watermark) to the central collector. Reads from
 * review_audit (de-noised, reversal-aware), anonymizes, signs, POSTs, then advances the cursor.
 * Returns the number of events exported (0 if air-gap, disabled, or nothing new).
 */
export async function exportOrbBatch(db: D1Database, batchSize = 200, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!orbEnabled()) return 0;
  if ((process.env.ORB_AIR_GAP ?? "").toLowerCase() === "true") return 0;

  // gittensory's hosted collector. No shared secret is sent: repo/PR identifiers are HMAC'd with THIS
  // instance's own ORB_WEBHOOK_SECRET, and the collector accepts the batch as untrusted, rate-limited telemetry.
  const collectorUrl = process.env.ORB_COLLECTOR_URL ?? "https://gittensory-api.aethereal.dev/v1/orb/ingest";
  const secret = process.env.ORB_WEBHOOK_SECRET ?? "";
  const anonymize = (process.env.ORB_ANONYMIZE ?? "true").toLowerCase() !== "false";
  const instance = instanceId();

  // Read this instance's export watermark (resumes where the last run left off).
  const cursorRow = await db
    .prepare(`SELECT last_exported_at FROM orb_export_cursor WHERE instance_hash = ?`)
    .bind(instance)
    .first<{ last_exported_at: string }>();
  const cursor = cursorRow?.last_exported_at ?? "2000-01-01T00:00:00Z";

  const { results } = await db.prepare(FLEET_QUERY).bind(cursor, batchSize).all<FleetRow>();
  if (!results || results.length === 0) return 0;

  const payload: OrbExportPayload = {
    instance_id: instance,
    events: results.map((r) => ({
      repo_hash: anonymize ? hmacField(r.project, secret) : r.project,
      pr_hash: anonymize ? hmacField(r.target_id, secret) : r.target_id,
      gate_verdict: r.verdict,
      outcome: r.outcome,
      reversal_flag: r.reverted ? "reverted" : r.reopened ? "reopened" : "none",
      gate_reasoncode_bucket: bucketReasonCode(r.reasoncode),
      time_to_close_ms: cycleTimeMs(r.decided_at, r.outcome_at),
      decision_timestamp: r.decided_at,
      outcome_timestamp: r.outcome_at,
    })),
  };

  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const res = await fetchFn(collectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orb-signature": `sha256=${signature}`, "x-orb-instance": instance },
      body,
    });
    if (!res.ok) {
      incr("gittensory_orb_export_errors_total");
      return 0;
    }
  } catch {
    incr("gittensory_orb_export_errors_total");
    return 0;
  }

  // Advance the watermark to the newest event in this batch (rows are ordered by event_at ascending).
  const newWatermark = results[results.length - 1]!.event_at;
  await db
    .prepare(`INSERT OR REPLACE INTO orb_export_cursor (instance_hash, last_exported_at, updated_at) VALUES (?, ?, ?)`)
    .bind(instance, newWatermark, new Date().toISOString())
    .run();

  incr("gittensory_orb_events_exported_total", {}, results.length);
  return results.length;
}
