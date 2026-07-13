// Gittensory Orb (#1255) — fleet calibration EXPORTER. Each self-hosted instance already records de-noised
// ground truth in review_audit (gate_decision + pr_outcome + reversal_reopened/reversal_reverted) via the
// engine's outcomes-wire. This ships an anonymized, reversal-aware signal UP to gittensory's central
// collector so the gate can be calibrated across the whole self-host fleet.
//
// Export is ALWAYS ON once the GitHub App is configured (the fleet-telemetry contract of self-hosting) —
// there is no opt-out flag. It self-gates on a configured App private key (no App → no review data to
// export anyway) and anonymizes with a DEDICATED, per-instance secret generated once and persisted in
// system_flags (never the App private key or the webhook-verification secret — key separation).
//   ORB_COLLECTOR_URL=<url>   — endpoint (default: gittensory's hosted collector)
//   ORB_AIR_GAP=true          — air-gapped/offline deployments only: compute locally, never send
//   ORB_ANONYMIZE=true        — HMAC-hash repo/PR before export (default: true)
//   ORB_COLLECTOR_TOKEN=<secret> — bearer credential for the hosted collector
//
// No diffs, no code, no comments, no logins, no commit SHAs — only verdict + outcome + reversal + a bucketed
// reason category + cycle time, with repo/PR identifiers HMAC'd by a key the collector never holds (so it
// can never de-anonymize).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { incr } from "./metrics";

/** Key under which the per-instance anonymization secret is persisted in system_flags. */
const ANON_SECRET_FLAG = "orb:anon_secret";

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

/** Stable instance identifier (hash of the Orb/App ID — no PII). A brokered instance holds no App id, so its
 *  dedicated anonymization secret becomes the stable identity so ORB_ENROLLMENT_SECRET is never reused as
 *  a correlatable telemetry identifier. */
function instanceId(anonSecret: string): string {
  const seed = process.env.ORB_APP_ID ?? process.env.GITHUB_APP_ID ?? `anon:${anonSecret}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/** HMAC a string with the instance's own secret for anonymized export. */
function hmacField(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}

/**
 * The instance's DEDICATED anonymization secret: a 256-bit random key generated once and persisted in
 * system_flags, then reused on every export. Stable across restarts so a repo/PR always hashes the same
 * way (the collector can dedup), per-instance, and SINGLE-PURPOSE — never the App private key or the
 * webhook-verification secret (key separation). The collector never holds it, so it cannot de-anonymize.
 */
export async function getOrCreateAnonSecret(db: D1Database): Promise<string> {
  const read = async (): Promise<string | undefined> => {
    const row = await db
      .prepare(`SELECT value FROM system_flags WHERE key = ?`)
      .bind(ANON_SECRET_FLAG)
      .first<{ value: string }>();
    return row?.value;
  };
  const existing = await read();
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex"); // 256-bit, 64 hex chars
  // Race-safe across instances sharing a Postgres DB: OR IGNORE keeps the first writer's key; the re-read
  // returns whichever value won, so every instance converges on the same secret.
  await db
    .prepare(`INSERT OR IGNORE INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .bind(ANON_SECRET_FLAG, generated)
    .run();
  /* v8 ignore next -- a row always exists after INSERT OR IGNORE, so the ?? fallback is unreachable */
  return (await read()) ?? generated;
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
  WHERE (event_at > ?) OR (event_at = ? AND target_id > ?)
  ORDER BY event_at ASC, target_id ASC
  LIMIT ?`;

/** ms between the gate decision and the resolution; null if implausible (NaN or negative). */
function cycleTimeMs(decidedAt: string, outcomeAt: string): number | null {
  const ms = new Date(outcomeAt).getTime() - new Date(decidedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Export newly-resolved PR outcomes (since this instance's watermark) to the central collector. Reads from
 * review_audit (de-noised, reversal-aware), anonymizes, signs, POSTs, then advances the cursor.
 * Returns the number of events exported (0 if air-gapped, the App isn't configured, or nothing new).
 */
export async function exportOrbBatch(db: D1Database, batchSize = 200, fetchFn: typeof fetch = fetch): Promise<number> {
  // Air-gapped/offline deployments explicitly suppress every outbound telemetry call, including brokered mode.
  if ((process.env.ORB_AIR_GAP ?? "").toLowerCase() === "true") return 0;

  // A brokered self-host relies on the central Orb for tokens + webhook relay, so it has review data to export but
  // no local App key. Otherwise, gate export on the local GitHub App private key being configured.
  const brokered = Boolean((process.env.ORB_ENROLLMENT_SECRET ?? "").trim());
  if (!brokered && !(process.env.GITHUB_APP_PRIVATE_KEY ?? "")) return 0;

  // gittensory's hosted collector. No shared secret is sent: repo/PR identifiers are HMAC'd with this
  // instance's DEDICATED anonymization secret (a 256-bit random key generated once and persisted in
  // system_flags — see getOrCreateAnonSecret), single-purpose and never the App key, so the collector
  // (which never holds it) can never de-anonymize them.
  const collectorUrl = process.env.ORB_COLLECTOR_URL ?? "https://gittensory-api.aethereal.dev/v1/orb/ingest";
  const secret = await getOrCreateAnonSecret(db);
  const anonymize = (process.env.ORB_ANONYMIZE ?? "true").toLowerCase() !== "false";
  const instance = instanceId(secret);

  // Read this instance's export watermark (resumes where the last run left off).
  const cursorRow = await db
    .prepare(`SELECT last_exported_at, last_exported_target_id FROM orb_export_cursor WHERE instance_hash = ?`)
    .bind(instance)
    .first<{ last_exported_at: string; last_exported_target_id?: string }>();
  const cursorAt = cursorRow?.last_exported_at ?? "2000-01-01T00:00:00Z";
  const cursorTargetId = cursorRow?.last_exported_target_id ?? "";

  const { results } = await db.prepare(FLEET_QUERY).bind(cursorAt, cursorAt, cursorTargetId, batchSize).all<FleetRow>();
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
  const collectorToken = process.env.ORB_COLLECTOR_TOKEN;

  try {
    const res = await fetchFn(collectorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orb-signature": `sha256=${signature}`,
        "x-orb-instance": instance,
        ...(collectorToken ? { authorization: `Bearer ${collectorToken}` } : {}),
      },
      body,
    });
    if (!res.ok) {
      incr("loopover_orb_export_errors_total");
      return 0;
    }
  } catch {
    incr("loopover_orb_export_errors_total");
    return 0;
  }

  // Advance the watermark to the newest event in this batch (rows are ordered by event_at, target_id).
  const lastRow = results[results.length - 1]!;
  await db
    .prepare(
      `INSERT OR REPLACE INTO orb_export_cursor (instance_hash, last_exported_at, last_exported_target_id, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(instance, lastRow.event_at, lastRow.target_id, new Date().toISOString())
    .run();

  incr("loopover_orb_events_exported_total", {}, results.length);
  return results.length;
}
