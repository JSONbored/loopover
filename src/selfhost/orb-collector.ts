// Gittensory Orb (#1219) — local outcome-signal collector. Records gate verdict + final PR
// outcome (merged/closed) for every PR the engine reviewed, enabling calibration of gate
// thresholds and AI prompts from real-world feedback signals.
//
// Collection is always local (DB only). Export to the central collector is opt-in:
//   ORB_ENABLED=true          — activates collection (off by default)
//   ORB_COLLECTOR_URL=<url>   — endpoint to export batches to (default: https://orb.gittensory.app/v1/ingest)
//   ORB_AIR_GAP=true          — keep all events local, never send externally
//   ORB_ANONYMIZE=true        — HMAC-hash repo/owner before export (default: true)
//
// Nothing is ever sent without ORB_ENABLED=true. No diffs, no code, no comments, no user
// identifiers — only aggregate outcome metadata (repo-hash, verdict, outcome, timing).
import { createHash, createHmac } from "node:crypto";
import { incr } from "./metrics";

export interface OrbEvent {
  repo: string;
  pr_number: number;
  head_sha: string;
  outcome: "merged" | "closed";
  gate_verdict?: string;
  time_to_close_ms?: number;
}

interface OrbRow {
  id: number;
  repo: string;
  pr_number: number;
  head_sha: string;
  outcome: string;
  gate_verdict: string | null;
  time_to_close_ms: number | null;
  created_at: string;
  exported_at: string | null;
}

interface OrbExportPayload {
  instance_id: string;
  events: Array<{
    repo_hash: string;
    pr_hash: string;
    outcome: string;
    gate_verdict: string | null;
    time_to_close_ms: number | null;
    created_at: string;
  }>;
}

/** Stable instance identifier (hash of the App ID — no PII). */
function instanceId(): string {
  return createHash("sha256").update(process.env.GITHUB_APP_ID ?? "unknown").digest("hex").slice(0, 16);
}

/** HMAC a string with the webhook secret for anonymized export. */
function hmacField(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}

/** Returns true only when Orb collection is explicitly enabled. */
export function orbEnabled(): boolean {
  const v = (process.env.ORB_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Record a single outcome event in the local DB. No-op when ORB_ENABLED is false. */
export async function recordOrbEvent(db: D1Database, event: OrbEvent): Promise<void> {
  if (!orbEnabled()) return;
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO orb_events (repo, pr_number, head_sha, outcome, gate_verdict, time_to_close_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(event.repo, event.pr_number, event.head_sha, event.outcome, event.gate_verdict ?? null, event.time_to_close_ms ?? null)
      .run();
    incr("gittensory_orb_events_recorded_total");
  } catch {
    // best-effort — never let Orb collection crash job processing
  }
}

/**
 * Export pending Orb events to the central collector. Called periodically (e.g. hourly).
 * Reads up to `batchSize` unexported events, signs and POSTs them, marks them as exported.
 * Returns the number of events exported (0 if air-gap, disabled, or nothing pending).
 */
export async function exportOrbBatch(
  db: D1Database,
  batchSize = 200,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  if (!orbEnabled()) return 0;
  if ((process.env.ORB_AIR_GAP ?? "").toLowerCase() === "true") return 0;

  const collectorUrl = process.env.ORB_COLLECTOR_URL ?? "https://orb.gittensory.app/v1/ingest";
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const anonymize = (process.env.ORB_ANONYMIZE ?? "true").toLowerCase() !== "false";

  const { results } = await db
    .prepare(`SELECT * FROM orb_events WHERE exported_at IS NULL ORDER BY id LIMIT ?`)
    .bind(batchSize)
    .all<OrbRow>();

  if (!results || results.length === 0) return 0;

  const payload: OrbExportPayload = {
    instance_id: instanceId(),
    events: results.map((r) => ({
      repo_hash: anonymize ? hmacField(r.repo, secret) : r.repo,
      pr_hash: anonymize ? hmacField(`${r.repo}#${r.pr_number}`, secret) : String(r.pr_number),
      outcome: r.outcome,
      gate_verdict: r.gate_verdict,
      time_to_close_ms: r.time_to_close_ms,
      created_at: r.created_at,
    })),
  };

  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const res = await fetchFn(collectorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orb-signature": `sha256=${signature}`,
        "x-orb-instance": instanceId(),
      },
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

  // Mark all exported events
  const ids = results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const now = new Date().toISOString();
  await db.prepare(`UPDATE orb_events SET exported_at=? WHERE id IN (${placeholders})`).bind(now, ...ids).run();

  incr("gittensory_orb_events_exported_total", {}, ids.length);
  return ids.length;
}
