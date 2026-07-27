// LoopOver federated fleet intelligence (#1970) — OPT-IN, peer-to-peer calibration bundle EXPORT (#6478).
//
// This is the EXPORT side only: it packages a subset of this instance's own local calibration data into a
// signed, anonymized bundle an operator can choose to hand to a peer. It performs NO network call — the
// transport (push/pull against an operator-configured collector) is #6479, the receiving/trust-gating side is
// #6480, and the key-trust scheme is #6477's design (see signFederatedBundle's own doc comment below for the
// dedicated signing key #9147 introduced).
//
// NOT the same thing as the #1255 orb export (src/selfhost/orb-collector.ts:155). That path is deliberately
// distinct on five axes, and this module exists precisely because none of them can be retrofitted onto it:
//   1. TRIGGER      — #1255 is ALWAYS ON once the App is configured (orb-collector.ts:6-7 "there is no opt-out
//                     flag"); its only suppressor is the ORB_AIR_GAP env var (orb-collector.ts:157). This is
//                     OPT-IN via `.loopover.yml` config-as-code, default OFF.
//   2. DESTINATION  — #1255 POSTs UP to loopover's central hosted collector (orb-collector.ts:168,
//                     https://api.loopover.ai/v1/orb/ingest). A federated bundle goes to a PEER or an operator's
//                     own collector; no central service is assumed anywhere.
//   3. GRANULARITY  — #1255 streams a watermark-paginated PER-PR event stream. This is a single AGGREGATE
//                     calibration snapshot over a window.
//   4. PRIVACY FLOOR— #1255 still carries HMAC'd repo_hash/pr_hash per event (orb-collector.ts:187-188). This
//                     carries ZERO identifiers, not even hashed ones: the aggregate query below never SELECTs
//                     an identifying column at all, so the floor is structural rather than a filtering step.
//   5. CONTENT      — #1255 exports raw per-PR verdict/outcome/reversal. This exports aggregate calibration
//                     precision plus bucketed slop/copycat rates.
//
// The precision math is REUSED from the fleet analytics (foldInstance) rather than reimplemented, deliberately:
// #6481 renders "this instance's gate precision vs the peer median", so a bundle's mergePrecision must be
// computed by the exact same confusion-matrix definition the fleet median uses, or the comparison is
// apples-to-oranges. Same reason MIN_DECIDED gates the published precision here.
import { createHmac, randomBytes } from "node:crypto";
import { bucketReasonCode, cycleTimeMs, getOrCreateInstanceIdentitySecret, instanceId } from "../selfhost/orb-collector";
import { foldInstance, MIN_DECIDED, percentile, type Cell as FleetCell } from "./analytics";
import type { FocusManifest } from "../signals/focus-manifest";

/** Bumped whenever the bundle's field set or semantics change, so a receiving instance (#6480) can reject or
 *  upgrade a bundle it does not understand instead of silently misreading it. */
export const FEDERATED_BUNDLE_SCHEMA_VERSION = 1;

/** Default calibration window. Mirrors computeFleetAnalytics' 90-day default and 365-day clamp so a bundle's
 *  window is directly comparable to the fleet's. Exported (#9148) so the import side can range-check a peer's
 *  `windowDays` and the benchmark side can compare a peer's window against this instance's own, without
 *  duplicating the clamp. */
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 365;

/** Resolve the effective window (days) from a caller-supplied override, exactly as {@link buildFederatedBundle}
 *  does internally — extracted so {@link buildFederatedBenchmark} (federated-benchmark.ts) can compute the
 *  SAME value to pass to the import side's window-match check (#9148) without forking the clamp logic. */
export function resolveFederatedWindowDays(windowDaysOverride: number | undefined): number {
  return Number.isFinite(windowDaysOverride) && (windowDaysOverride as number) > 0
    ? Math.min(windowDaysOverride as number, MAX_WINDOW_DAYS)
    : DEFAULT_WINDOW_DAYS;
}

/**
 * The signed payload of a federated calibration bundle: every field except the signature itself.
 *
 * EVERY FIELD IS ENUMERATED HERE AND IS AGGREGATE-ONLY. There is deliberately no source code, no diff, no
 * GitHub login, no repo name, no PR number/id, no commit SHA, no raw gate reason text and no per-PR row — the
 * query that feeds this never selects any of them. `instanceId` is the same opaque, HMAC-derived handle the
 * existing orb pipeline already uses (src/selfhost/orb-collector.ts:59), not an identity.
 *
 * Adding a field here is a deliberate privacy decision: the schema test asserts this exact key set and fails
 * if it changes, so a new field cannot land without review.
 */
export interface FederatedSignalBundleBody {
  /** Schema contract version — see FEDERATED_BUNDLE_SCHEMA_VERSION. */
  schemaVersion: number;
  /** Opaque per-instance handle (no PII) — reused from the orb pipeline so peers can dedup bundles. */
  instanceId: string;
  /** ISO timestamp this bundle was built. */
  generatedAt: string;
  /** Length of the calibration window, so peers only median equal-length windows. */
  windowDays: number;
  /** Resolved PRs in-window that the gate decided. Drives the MIN_DECIDED eligibility bar below. */
  decided: number;
  /** P(merged & not reverted | gate said merge). Null until `decided` >= MIN_DECIDED. */
  mergePrecision: number | null;
  /** P(closed & not reopened | gate said close). Null until `decided` >= MIN_DECIDED. */
  closePrecision: number | null;
  /** P(closed or reverted | gate said merge) — the gate approved and was wrong. Null until eligible. */
  fpRate: number | null;
  /** P(merged or reopened | gate said close) — the gate blocked and was wrong. Null until eligible. */
  fnRate: number | null;
  /** Share of decided PRs a human reversed. 0 when nothing was decided. */
  reversalRate: number;
  /** Median gate-decision → resolution latency. Null until eligible or when no cycle time is measurable. */
  cycleP50Ms: number | null;
  /** p95 gate-decision → resolution latency. Null until eligible or when no cycle time is measurable. */
  cycleP95Ms: number | null;
  /** Share of decided PRs whose gate reason bucketed to "slop_advisory" — an aggregate rate, never PR text. */
  slopRate: number;
  /** Share of decided PRs whose gate reason bucketed to "duplicate_risk" — an aggregate rate. Deliberately
   *  NOT a per-shingle hash list or cluster id: no persisted shingle source exists, and duplicate-cluster
   *  winner linkage is an explicit non-goal of this pipeline (see src/orb/analytics.ts's OUT OF SCOPE note). */
  copycatRate: number;
}

/** A federated calibration bundle: the signed body plus its detached HMAC. */
export interface FederatedSignalBundle extends FederatedSignalBundleBody {
  /** Hex HMAC-SHA256 over canonicalizeFederatedBundleBody(body) — see signFederatedBundle. */
  signature: string;
}

/** One resolved-PR row of this instance's own local ground truth. Carries NO identifier by construction — see
 *  LOCAL_CALIBRATION_QUERY, which never selects project/target_id. */
interface LocalRow {
  verdict: string | null;
  reasoncode: string | null;
  decided_at: string;
  outcome: string;
  outcome_at: string;
  reverted: number;
  reopened: number;
}

// Latest gate_decision + latest pr_outcome per target_id, plus any reversal, restricted to a window. Mirrors
// FLEET_QUERY's CTE shape (src/selfhost/orb-collector.ts:107) so it stays portable across the SQLite self-host
// and Postgres backends (window functions + CASE, no SQLite-only bare-column-with-MAX).
//
// The privacy floor is enforced HERE: the projection selects only verdict/outcome/reversal/timing. `project`
// and `target_id` are joined on but never selected, so no identifier can reach a bundle even by mistake.
const LOCAL_CALIBRATION_QUERY = `
  WITH gd AS (
    SELECT target_id, decision AS verdict, summary AS reasoncode, created_at AS decided_at,
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
      MAX(CASE WHEN event_type = 'reversal_reopened' THEN 1 ELSE 0 END) AS reopened
    FROM review_audit
    WHERE event_type IN ('reversal_reverted', 'reversal_reopened')
    GROUP BY target_id
  )
  SELECT gd.verdict AS verdict, gd.reasoncode AS reasoncode, gd.decided_at AS decided_at,
         po.outcome AS outcome, po.outcome_at AS outcome_at,
         COALESCE(rev.reverted, 0) AS reverted, COALESCE(rev.reopened, 0) AS reopened
  FROM gd
  JOIN po ON gd.target_id = po.target_id
  LEFT JOIN rev ON gd.target_id = rev.target_id
  WHERE gd.rn = 1 AND po.rn = 1 AND po.outcome_at >= ?`;

/**
 * Canonical JSON for signing: the body's keys are emitted in this exact, documented order so a receiving
 * instance (#6480) can recompute the HMAC byte-for-byte without depending on JS key-insertion order.
 */
export function canonicalizeFederatedBundleBody(body: FederatedSignalBundleBody): string {
  return JSON.stringify([
    ["schemaVersion", body.schemaVersion],
    ["instanceId", body.instanceId],
    ["generatedAt", body.generatedAt],
    ["windowDays", body.windowDays],
    ["decided", body.decided],
    ["mergePrecision", body.mergePrecision],
    ["closePrecision", body.closePrecision],
    ["fpRate", body.fpRate],
    ["fnRate", body.fnRate],
    ["reversalRate", body.reversalRate],
    ["cycleP50Ms", body.cycleP50Ms],
    ["cycleP95Ms", body.cycleP95Ms],
    ["slopRate", body.slopRate],
    ["copycatRate", body.copycatRate],
  ]);
}

/**
 * HMAC-sign a bundle body so a receiving instance can verify it was not tampered with in transit.
 *
 * KEY-TRUST (#6477, ratified as an allowlist design — NOT a PKI/reputation system): the signing key is this
 * instance's DEDICATED federated-signing secret (getOrCreateFederatedSigningSecret) — a symmetric HMAC key a
 * peer must hold verbatim to verify a bundle. #9147: this is deliberately a SEPARATE secret from the always-on
 * #1255 orb export's anonymization secret (getOrCreateAnonSecret in ../selfhost/orb-collector.ts). Handing a
 * peer the federated signing key must never also hand them the key that de-anonymizes this instance's
 * unrelated, always-on telemetry — the two secrets share no value and are rotatable independently. Peer trust
 * itself is established on the RECEIVING side, where #6480 has SHIPPED (src/orb/federated-import.ts): an
 * importing operator explicitly adds a peer's verification key to `federatedIntelligence.peerKeys`
 * (fail-closed when unset), and only an allowlisted key can verify a bundle. So this signature is the
 * tamper-evidence layer; the receiver's allowlist is what turns it into peer trust.
 */
export function signFederatedBundle(body: FederatedSignalBundleBody, key: string): string {
  return createHmac("sha256", key).update(canonicalizeFederatedBundleBody(body)).digest("hex");
}

/** system_flags key for the federated bundle's OWN signing secret (#9147) — never `orb:anon_secret`. */
const FEDERATED_SIGNING_SECRET_FLAG = "orb:federated_signing_secret";

/**
 * The instance's DEDICATED federated-signing secret (#9147): a 256-bit random key generated once and
 * persisted in system_flags, distinct from every other secret this codebase mints (the App private key, the
 * webhook-verification secret, and — the specific bug this closes — the always-on orb export's anonymization
 * secret). An operator enrolling a peer only ever hands out THIS value, so a peer can never use it to
 * de-anonymize the unrelated #1255 telemetry export, and rotating either secret never affects the other.
 */
export async function getOrCreateFederatedSigningSecret(db: D1Database): Promise<string> {
  const read = async (): Promise<string | undefined> => {
    const row = await db.prepare(`SELECT value FROM system_flags WHERE key = ?`).bind(FEDERATED_SIGNING_SECRET_FLAG).first<{ value: string }>();
    return row?.value;
  };
  const existing = await read();
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex"); // 256-bit, 64 hex chars — same shape as generateAnonSecret
  await db
    .prepare(`INSERT OR IGNORE INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .bind(FEDERATED_SIGNING_SECRET_FLAG, generated)
    .run();
  /* v8 ignore next -- a row always exists after INSERT OR IGNORE, so the ?? fallback is unreachable */
  return (await read()) ?? generated;
}

/** Is the federated export opted in for this deployment? Absent block ⇒ false ⇒ byte-identical behavior. */
export function isFederatedIntelligenceEnabled(manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined): boolean {
  return manifest?.federatedIntelligence?.enabled === true;
}

/**
 * Build this instance's signed, anonymized federated calibration bundle.
 *
 * Returns null — reading nothing and calling nothing — unless the operator has explicitly opted in via
 * `federatedIntelligence.enabled: true` in `.loopover.yml`. An instance that has not opted in is byte-identical
 * to before this module existed: no DB read, no network call (this module never makes one at all), no side
 * effect.
 *
 * FAIL-SAFE: any error while building degrades to null. This is a pure library that the gate never awaits, so
 * a failure here can never alter review/merge behavior — but the catch makes that guarantee explicit rather
 * than incidental.
 */
export async function buildFederatedBundle(
  manifest: Pick<FocusManifest, "federatedIntelligence"> | null | undefined,
  db: D1Database,
  opts: { windowDays?: number; now?: number } = {},
): Promise<FederatedSignalBundle | null> {
  if (!isFederatedIntelligenceEnabled(manifest)) return null;

  try {
    const windowDays = resolveFederatedWindowDays(opts.windowDays);
    const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
    // Date-only cutoff, like computeFleetAnalytics — compares correctly whether created_at is ISO ('…T…Z') or
    // SQLite's CURRENT_TIMESTAMP space format ('YYYY-MM-DD HH:MM:SS').
    const cutoff = new Date(now - windowDays * 86_400_000).toISOString().slice(0, 10);

    // #9147: instanceId is derived from the dedicated IDENTITY secret (shared with the #1255 orb export, so
    // both pipelines dedup the same instance under the same handle) — never from the anon secret or the
    // federated signing secret below, so rotating either never changes this instance's identity.
    const instance = instanceId(await getOrCreateInstanceIdentitySecret(db));

    const { results } = await db.prepare(LOCAL_CALIBRATION_QUERY).bind(cutoff).all<LocalRow>();
    const rows = results ?? [];
    const decided = rows.length;

    // Reuse the fleet's confusion-matrix fold so this instance's precision is defined identically to the peer
    // median it will be compared against (#6481). One cell per row; foldInstance sums their `n`.
    const cells: FleetCell[] = rows.map((r) => ({
      instance_id: instance,
      verdict: r.verdict,
      outcome: r.outcome,
      reversal_flag: r.reverted ? "reverted" : r.reopened ? "reopened" : "none",
      n: 1,
    }));
    const metrics = decided > 0 ? foldInstance(instance, cells) : null;

    // Below MIN_DECIDED the precision figures are noise, and the fleet would not count them toward a median
    // anyway (src/orb/analytics.ts's `eligible` filter) — so publish them as null rather than as a number a
    // peer would wrongly average in.
    const eligible = decided >= MIN_DECIDED;

    const cycleTimes = rows
      .map((r) => cycleTimeMs(r.decided_at, r.outcome_at))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);

    const bucketShare = (bucket: string): number =>
      decided > 0 ? rows.filter((r) => bucketReasonCode(r.reasoncode) === bucket).length / decided : 0;

    const body: FederatedSignalBundleBody = {
      schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
      instanceId: instance,
      generatedAt: new Date(now).toISOString(),
      windowDays,
      decided,
      mergePrecision: eligible && metrics ? metrics.mergePrecision : null,
      closePrecision: eligible && metrics ? metrics.closePrecision : null,
      fpRate: eligible && metrics ? metrics.fpRate : null,
      fnRate: eligible && metrics ? metrics.fnRate : null,
      reversalRate: metrics ? metrics.reversalRate : 0,
      cycleP50Ms: eligible ? percentile(cycleTimes, 50) : null,
      cycleP95Ms: eligible ? percentile(cycleTimes, 95) : null,
      slopRate: bucketShare("slop_advisory"),
      copycatRate: bucketShare("duplicate_risk"),
    };

    // #9147: signed with the DEDICATED federated signing secret — never the anon secret above, and never
    // shared with any other credential — so handing this key to a peer can only ever verify federated
    // bundles, not de-anonymize the unrelated always-on orb export.
    const signingSecret = await getOrCreateFederatedSigningSecret(db);
    return { ...body, signature: signFederatedBundle(body, signingSecret) };
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", event: "federated_bundle_failed", message: String(error).slice(0, 200) }),
    );
    return null;
  }
}
