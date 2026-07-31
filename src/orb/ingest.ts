// LoopOver Orb (#1255) — central fleet-calibration collector receiver.
// Accepts anonymized, reversal-aware outcome batches from self-hosted instances (exportOrbBatch).
// No raw repo names, owner identifiers, commit SHAs, or PR content — only HMAC-anonymized hashes +
// aggregate calibration metadata (verdict, outcome, reversal, bucketed reason, cycle time).
import { hashToken } from "../auth/security";
import { validateCalibrationPayload } from "../review/risk-control";

const MAX_BATCH = 500;
const MAX_INSTANCE_ID_CHARS = 64;
const MAX_HASH_CHARS = 128;
const MAX_BUCKET_CHARS = 64;
const MAX_VERDICT_CHARS = 32;
const MAX_TIMESTAMP_CHARS = 64;
const VALID_OUTCOMES = new Set(["merged", "closed"]);
const VALID_REVERSALS = new Set(["none", "reopened", "reverted", "superseded"]);
// gate_verdict is read downstream as a CLOSED enum by exact equality (analytics.ts foldInstance branches on
// "merge"/"close"); an off-vocabulary value would silently fall into `holds` and understate published coverage.
// It is the honest writer's GateAction vocabulary (parity.ts): merge | close | hold.
const VALID_VERDICTS = new Set(["merge", "close", "hold"]);
// gate_reasoncode_bucket is compared against "policy_action" downstream; the writer (bucketReasonCode,
// orb-collector.ts) emits exactly these nine literals. Anything else is coerced to null (foldInstance already
// treats null as a normal quality verdict), so an older/buggier registered instance cannot poison its coverage.
const VALID_REASONCODE_BUCKETS = new Set([
  "none",
  "policy_action",
  "issue_policy",
  "duplicate_risk",
  "slop_advisory",
  "ai_quality",
  "author_policy",
  "ci_readiness",
  "other",
]);
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

/** The minimal shape {@link readOrbIngestBody} needs from its input: a byte stream. Both `Request` and
 *  `Response` satisfy this structurally (the Fetch API gives both a `.body: ReadableStream<Uint8Array> |
 *  null`), so this reader works unmodified over either — #9148 reuses it for a collector `Response` body
 *  (src/orb/federated-collector.ts's pullPeerBundles) instead of writing a second bounded reader. */
export type BoundedBodySource = { body: ReadableStream<Uint8Array> | null };

/** Read a request/response body with a hard byte ceiling so a hostile sender can't make us buffer unbounded
 *  input. Returns null when the body exceeds MAX_ORB_INGEST_BODY_BYTES OR when the underlying stream
 *  itself errors (a dropped connection / network reset mid-read, mirrors readOrbRelayRegisterBody in
 *  ../orb/relay.ts) — every caller (/v1/orb/ingest, /v1/ams/ingest, and #9148's federated-collector pull)
 *  already treats null identically to "reject this", so a transient read failure degrades the same way an
 *  oversized payload does, instead of throwing UNCAUGHT out of this function as a bare framework 500. */
export async function readOrbIngestBody(source: BoundedBodySource, contentLengthHeader: string | null | undefined): Promise<string | null> {
  const declared = parseContentLength(contentLengthHeader);
  if (declared !== null && declared > MAX_ORB_INGEST_BODY_BYTES) return null;

  const stream = source.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
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
  } catch {
    return null;
  }
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
  // #8820: optional day-bucketed cache hit/miss aggregates for the public "AI work reused" trend (counts
  // only). A rolling window re-sent every tick; upserted per (instance, day). Absent from older builds.
  reuse_counters?: Array<{ day?: unknown; hits?: unknown; misses?: unknown }>;
}

/** Rolling-window bound: the sender exports ~70 days (REUSE_COUNTER_WINDOW_DAYS); anything wildly larger is
 *  a hostile payload padding the loop, not a real export. */
const MAX_REUSE_COUNTER_DAYS = 400;
const MAX_REUSE_COUNT = 10_000_000; // per-day per-instance ceiling — beyond this is fabrication, not telemetry
const REUSE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Clamp a sender-supplied per-day counter to a plausible non-negative integer; null rejects the row. */
function clampReuseCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > MAX_REUSE_COUNT) return null;
  return rounded;
}

/** Validate a sender-supplied timestamp (#10028). Returns the string unchanged only when it is a
 *  length-capped, `Date.parse`-able instant; otherwise null. decision_timestamp is the day bucket for the
 *  public fleet-accuracy trend and the retention rollup key, so a non-instant string would sort above every
 *  ISO date in the lexicographic window bound, be dropped in JS, and leave a permanent junk `day` in the
 *  rollup PK. Null lets `COALESCE(decision_timestamp, received_at)` fall back to the server clock, so the
 *  signal still counts. Mirrors the REUSE_DAY_PATTERN + clampReuseCount pair one field family over. */
export function normalizeIngestTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_CHARS) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export type OrbIngestResult = { accepted: number } | { error: string };

/** Clamp a sender-supplied cycle time to a plausible range; null for anything implausible/absent. */
function clampCycleMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_CYCLE_MS || value > MAX_CYCLE_MS) return null;
  return Math.round(value);
}

export async function handleOrbIngest(body: string, db: D1Database, presentedInstanceSecret?: string): Promise<OrbIngestResult> {
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
          typeof event.gate_verdict === "string" && event.gate_verdict.length <= MAX_VERDICT_CHARS && VALID_VERDICTS.has(event.gate_verdict) ? event.gate_verdict : null,
          event.outcome,
          reversal,
          typeof event.gate_reasoncode_bucket === "string" && event.gate_reasoncode_bucket.length <= MAX_BUCKET_CHARS && VALID_REASONCODE_BUCKETS.has(event.gate_reasoncode_bucket) ? event.gate_reasoncode_bucket : null,
          clampCycleMs(event.time_to_close_ms),
          normalizeIngestTimestamp(event.decision_timestamp),
          normalizeIngestTimestamp(event.outcome_timestamp),
          normalizeIngestTimestamp(event.outcome_timestamp),
        )
        .run();
      if (result.meta.changes > 0) accepted++;
    } catch {
      // best-effort — skip rows that violate constraints or hit transient errors
    }
  }

  // #8835/#9121: the instance's live risk-control calibrations. TRUST GATE: stored only when the sender is
  // a REGISTERED instance AND proves it with the per-instance credential minted at registration — a
  // published accuracy guarantee is the strongest claim on the homepage, and neither open ingest nor the
  // shared fleet-wide bearer token (proof only of "some fleet member") may be enough to plant or delete one.
  // Per-arm rows are scoped to THIS instance (orb_risk_control_arms); public-stats aggregates across
  // registered instances at read time, so one compromised or miscalibrated peer can only ever touch its own
  // row. Bounded: two known arms, shape/range-validated (#9068, validateCalibrationPayload) before storage,
  // then kept as JSON for public-stats to render.
  const riskControl = (payload as { risk_control?: unknown }).risk_control;
  if (riskControl !== undefined && riskControl !== null && typeof riskControl === "object" && !Array.isArray(riskControl)) {
    try {
      const instanceRow = await db
        .prepare("SELECT registered, ingest_secret_hash FROM orb_instances WHERE instance_id = ?")
        .bind(instance_id)
        .first<{ registered: number; ingest_secret_hash: string | null }>();
      if (instanceRow?.registered === 1) {
        // A registered instance's identity must be PROVEN by its own credential, not merely claimed in the
        // body — any holder of the shared fleet-wide bearer token could otherwise present ANY registered
        // instance_id. An instance registered before this credential existed (or not yet re-registered to
        // mint one) has no hash to check against, so the write is refused rather than silently trusted.
        const presentedHash = presentedInstanceSecret ? await hashToken(presentedInstanceSecret) : null;
        const authenticated = Boolean(instanceRow.ingest_secret_hash) && presentedHash === instanceRow.ingest_secret_hash;
        if (!authenticated) return { error: "instance_unauthenticated" };
        for (const arm of ["close", "merge"]) {
          // An ABSENT key is "no change" (this ingest tick had nothing new to say about the arm) — NEVER a
          // retraction. Only an EXPLICIT `null` retracts, so a truncated, partial, or older-schema payload
          // can't silently delete a live guarantee (#9121).
          const value = (riskControl as Record<string, unknown>)[arm];
          if (value === undefined) continue;
          if (value === null) {
            await db.prepare(`DELETE FROM orb_risk_control_arms WHERE instance_id = ? AND arm = ?`).bind(instance_id, arm).run();
          } else if (typeof value === "object" && !Array.isArray(value) && validateCalibrationPayload(value) !== null) {
            // #9068: shape/range-validated (status === "calibrated", alpha/lambda/coverage in range, nAtLambda
            // clears the zero-error floor for the payload's own alpha/delta) before it's allowed anywhere near
            // storage or the public surface — a sender claiming an uncertifiable guarantee is silently dropped,
            // the same best-effort posture as every other malformed row in this ingest.
            await db
              .prepare(
                `INSERT INTO orb_risk_control_arms (instance_id, arm, payload_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(instance_id, arm) DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP`,
              )
              .bind(instance_id, arm, JSON.stringify(value).slice(0, 2000))
              .run();
          }
        }
      }
    } catch {
      // best-effort — a calibration hiccup must never fail the outcome batch
    }
  }

  // #8820: day-bucketed reuse counters (optional field; older builds omit it). Every row is
  // whitelist-validated (strict YYYY-MM-DD day, clamped non-negative counts) and upserted on
  // (instance_id, day) — the sender re-exports a rolling window each tick, so REPLACE keeps the freshest
  // counts idempotently. Malformed rows are skipped one-by-one (same best-effort posture as events above);
  // a malformed CONTAINER (non-array) is ignored rather than failing the outcome batch riding alongside.
  const reuseCounters = (payload as OrbIngestPayload).reuse_counters;
  if (Array.isArray(reuseCounters)) {
    for (const counter of reuseCounters.slice(0, MAX_REUSE_COUNTER_DAYS)) {
      const day = typeof counter?.day === "string" && REUSE_DAY_PATTERN.test(counter.day) ? counter.day : null;
      const hits = clampReuseCount(counter?.hits);
      const misses = clampReuseCount(counter?.misses);
      if (day === null || hits === null || misses === null) continue;
      try {
        await db
          .prepare(
            `INSERT OR REPLACE INTO orb_reuse_counters (instance_id, day, hits, misses, received_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          )
          .bind(instance_id, day, hits, misses)
          .run();
      } catch {
        // best-effort — a counter hiccup must never fail the outcome batch
      }
    }
  }

  return { accepted };
}
