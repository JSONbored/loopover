// Internal-only submitter reputation (#submitter-reputation / #reputation-redesign). Derives a private
// per-(project, submitter) signal so the gate can be a touch more cautious with a serial low-quality or
// abusive resubmitter. STRICTLY INTERNAL: NEVER exposed publicly — no labels, no PR comments, no check-runs.
// It feeds the gate via a GENERIC public reason (the reputation cause never appears in any comment/summary),
// and surfaces only to the operator via the bearer-gated /stats. Fail-safe: every read/write is guarded and
// degrades to "neutral" / no-op (it must NEVER throw into the gate).
//
// REDESIGN (#reputation-redesign): the old signal was a raw close ratio over ALL-TIME submitter_stats counts,
// which (a) trapped high-volume contributors who sometimes ship good PRs purely on a ratio, and (b) counted
// merge-conflict closes (a rebase artifact, not quality) and OLD closes from a since-relaxed/over-strict bar.
// The new signal is QUALITY-weighted + RECENCY-aware: it reads review_targets (the source of truth) over a
// RECENT WINDOW, classifies each terminal outcome by its reasonCode, IGNORES conflict / out-of-band artifacts,
// and only brands "low" on CLEAR, RECENT, genuine abuse or serial quality-failure. The reputation signal ONLY
// routes to manual review (it NEVER closes), so we default GENEROUS to keep auto-merge flowing — old closes age
// out of the window and trapped contributors auto-correct with no migration. recordSubmissionOutcome still
// maintains submitter_stats for /stats, but the SIGNAL is now derived from review_targets.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + helper this module needs is
// defined HERE. No imports from reviewbot — the reviewbot `storage(env)` adapter is inlined as `env.DB`, and
// the `Env` / `ReputationConfig` types are declared locally. The CLASSIFY/SIGNAL/COUNT logic is byte-faithful
// to the reviewbot source (src/core/submitter-reputation.ts); the only deltas are mechanical guards for
// gittensory's stricter tsconfig (noUncheckedIndexedAccess / exactOptionalPropertyTypes), which don't change
// behavior. ADDITIVE + DORMANT: the DB-touching reads/writes assume the reviewbot D1 tables (review_targets,
// submitter_stats) — gittensory does not yet have them, so getSubmitterReputation / recordSubmissionOutcome
// degrade fail-safe (neutral / no-op) until a later migration lands them. The PURE classifiers
// (classifyOutcome / countOutcomes / signalFromCounts) are usable immediately.

// ── Inlined minimal deps (no reviewbot imports) ─────────────────────────────────────────────────────────

/** The D1 binding this module reads/writes. `Env` is gittensory's global ambient interface (env.DB: D1Database);
 *  it is referenced directly. The reviewbot `storage(env)` adapter maps to `env.DB` here. */
function storage(env: Env): D1Database {
  return env.DB;
}

/** Behavior-preserving inline of reviewbot's ReputationConfig (src/core/types.ts) — the tunable thresholds. */
export interface ReputationConfig {
  /** Only terminal outcomes in the last N days count toward the signal (recency window). */
  windowDays: number;
  /** Minimum quality-relevant sample before a signal is anything but 'neutral'. */
  minSample: number;
  /** Serial-fail → 'low' needs the weighted fail rate at/above this (0–1). */
  qualityFailLowRate: number;
  /** …AND fewer than this many recent successes (the success guard). */
  qualityFailLowMaxSuccess: number;
  /** The light bucket (flaky CI / honest-collision / transient-fetch) counts at this fraction of a reject (0–1). */
  lightFailWeight: number;
  /** 'trusted' needs at least this many recent successes. */
  trustedMinSuccess: number;
  /** …AND a fail rate at/under this (0–1). */
  trustedMaxFailRate: number;
}

export type ReputationSignal = "trusted" | "neutral" | "low";
export type SubmissionOutcome = "merged" | "closed" | "manual";

export interface SubmitterStats {
  submissions: number;
  merged: number;
  closed: number;
  manual: number;
  closeRate: number;
  signal: ReputationSignal;
}

// ── Recency window (#reputation-redesign): only terminal outcomes in the last REPUTATION_WINDOW count toward the
// signal, so the recently-SHIFTED bar is what's reflected and old over-strict closes age out automatically. The
// window query is bounded (per-project, per-submitter, indexed) and the row scan is capped. ──
export const REPUTATION_WINDOW_DAYS = 90;
// Hard ceiling on rows pulled for one submitter's window so a pathological history can't blow the query up.
const REPUTATION_WINDOW_ROW_CAP = 500;

// ── Submission-cadence signal (#4514). Every signal above is QUALITY-based (was the outcome good or bad) --
// none of them have a TIMING dimension, so a fast, well-formed, strategically-low-value submitter is
// invisible to the one dimension (superhuman pace) that would otherwise be a strong tell. This is queried
// from ALL review_targets rows (not just terminal ones, unlike the quality signal above) -- a fresh burst of
// still-open submissions is exactly the case this needs to catch, and by the time they become terminal the
// (paid) AI review has already run on each one. ──
const CADENCE_WINDOW_HOURS = 24;
// Need at least this many recent submissions before judging pace at all -- a lone fast submission (a real
// contributor who happened to open two PRs close together) is not a pattern.
const CADENCE_MIN_SAMPLE = 5;
// A human contributor, even a fast one, does not sustain a sub-10-minute median gap between distinct PR
// submissions across many consecutive attempts -- reading, writing, and testing each change takes real time.
const CADENCE_MAX_MEDIAN_GAP_MS = 10 * 60 * 1000;

export type SubmissionCadence = { count: number; medianGapMs: number | null };

/** Pure: the median gap (ms) between consecutive submissions, given their created_at timestamps in any order.
 *  `medianGapMs` is `null` when there are fewer than 2 samples (no gap to measure). */
export function computeSubmissionCadence(createdAtIsoTimestamps: readonly string[]): SubmissionCadence {
  const sorted = [...createdAtIsoTimestamps].map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  if (sorted.length < 2) return { count: sorted.length, medianGapMs: null };
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianGapMs = gaps.length % 2 === 0 ? (gaps[mid - 1]! + gaps[mid]!) / 2 : gaps[mid]!;
  return { count: sorted.length, medianGapMs };
}

/** Pure: does this cadence read as machine-paced? Needs both a real sample size AND a gap tighter than any
 *  human contributor plausibly sustains across that many consecutive attempts. */
export function isMachinePacedCadence(cadence: SubmissionCadence): boolean {
  return cadence.count >= CADENCE_MIN_SAMPLE && cadence.medianGapMs !== null && cadence.medianGapMs < CADENCE_MAX_MEDIAN_GAP_MS;
}

/** Per-repo submission cadence for one submitter over the last {@link CADENCE_WINDOW_HOURS}. Fail-safe:
 *  any read error degrades to `{ count: 0, medianGapMs: null }` (never machine-paced), identical in spirit to
 *  {@link getSubmitterReputation}'s fail-safe-to-neutral. */
export async function getSubmitterCadence(env: Env, project: string, submitter: string | undefined): Promise<SubmissionCadence> {
  if (!submitter) return { count: 0, medianGapMs: null };
  try {
    const result = await storage(env)
      .prepare(`SELECT created_at AS createdAt FROM review_targets WHERE project = ? AND submitter = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?`)
      .bind(project, submitter, `-${CADENCE_WINDOW_HOURS} hours`, REPUTATION_WINDOW_ROW_CAP)
      .all<{ createdAt: string }>();
    const createdAts = (result?.results ?? []).map((r) => r.createdAt);
    return computeSubmissionCadence(createdAts);
  } catch {
    return { count: 0, medianGapMs: null };
  }
}

// ── reasonCode → quality bucket (#reputation-redesign). Buckets reflect the LIVE D1 reasonCode taxonomy. ──
//   SUCCESS: a genuine reviewer/merge approval.
//   QUALITY_FAIL: a genuine RECENT reviewer reject (real quality signal).
//   QUALITY_FAIL_LIGHT: checks_failed — CI can be flaky / a shifted CI bar, so weigh it lighter.
//   ALSO in the LIGHT bucket (#reputation-too-harsh): strict_duplicate / source_unfetchable / source_archived /
//     protected_metadata_edit. On a high-volume list these are usually HONEST collisions (a duplicate someone
//     didn't realise was already listed) or TRANSIENT fetch failures — not malice. They were previously hard
//     ABUSE, which (with no success guard) branded legit high-volume contributors 'low'. They now count at the
//     light (~0.5) weight via weightedFails, so a contributor with many recent merges is never branded by them.
//   PROMPT_INJECTION: the ONLY remaining hard-abuse signal — genuinely malicious, any one is enough.
//   Everything else (and any unknown reasonCode) is EXCLUDED — not a quality signal.
const SUCCESS_CODES = new Set(["dual_review_approved", "dual_review_approved_tiebreak", "maintainer_cleanup"]);
const QUALITY_FAIL_CODES = new Set(["dual_review_declined", "scope_failure", "thin_description"]);
// The light bucket: flaky CI + the previously-"abuse" honest-collision / transient-fetch codes. Half weight.
const QUALITY_FAIL_LIGHT_CODES = new Set(["checks_failed", "strict_duplicate", "source_unfetchable", "source_archived", "protected_metadata_edit"]);
const PROMPT_INJECTION_CODE = "source_prompt_injection"; // the single, only hard-abuse signal — any one is enough.
// Conflict / out-of-band closes are a rebase artifact, not a quality signal: ALWAYS excluded (even if the row's
// status is 'closed'). Kept explicit for readability; the classifier defaults unknown codes to EXCLUDE anyway.
const CONFLICT_CODES = new Set(["merge_conflict_closed", "merge_conflict_close", "pr_closed_before_merge"]);

type Bucket = "success" | "quality_fail" | "quality_fail_light" | "prompt_injection" | "exclude";

/** Classify one recent terminal review_targets row into a quality bucket. `status` is the realized terminal
 *  state (merged | closed | manual | ...); `reasonCode` is decision_json.$.reasonCode (may be null). */
export function classifyOutcome(status: string, reasonCode: string | null): Bucket {
  // manual / held rows are neutral — ignore entirely.
  if (status === "manual") return "exclude";
  // A merged row is a SUCCESS regardless of reasonCode: an explicit success code, a null code (merged
  // out-of-band / older merges before reasonCode was recorded), or even a source_* code — it SHIPPED, so it is
  // never an abuse/fail signal. (The live D1 has e.g. `merged | source_prompt_injection` rows that nonetheless
  // merged; a merge is the ground-truth success.)
  if (status === "merged") return "success";
  // From here, non-merged terminal rows (closed/etc). A close WITHOUT a reasonCode, or one tagged with an
  // approval code, is a conflict / out-of-band close — NOT a quality signal.
  if (reasonCode === null || SUCCESS_CODES.has(reasonCode)) return "exclude";
  if (CONFLICT_CODES.has(reasonCode)) return "exclude";
  if (reasonCode === PROMPT_INJECTION_CODE) return "prompt_injection";
  if (QUALITY_FAIL_CODES.has(reasonCode)) return "quality_fail";
  if (QUALITY_FAIL_LIGHT_CODES.has(reasonCode)) return "quality_fail_light";
  // Any unrecognised close reasonCode: be GENEROUS — exclude rather than penalise.
  return "exclude";
}

/** The counted, recency-windowed buckets for one submitter (only the quality-relevant rows; the EXCLUDE bucket
 *  — conflicts, out-of-band, manual, unknown codes — is dropped before this). */
export interface ReputationCounts {
  success: number;
  qualityFail: number; // genuine reviewer rejects (heavier)
  qualityFailLight: number; // flaky CI + honest-collision / transient-fetch soft signals (lighter, ~0.5 weight)
  promptInjection: number; // the ONLY hard-abuse signal — genuinely malicious
}

// ── Signal thresholds (#reputation-redesign). Default GENEROUS: 'low' ONLY for CLEAR, RECENT, genuine abuse or
// serial quality-failure. A high-volume contributor with a healthy number of recent SUCCESSES is NEVER 'low'. ──
//
// These are GENERIC mechanism (not the gameable secret — they don't reveal a project's review DIRECTIONS), so
// the committed defaults stay. But a deployment can TUNE them privately via the `reputation` block of the
// private review-config, with the same fail-safe overlay discipline as the other knobs (a value that would
// LOOSEN the gate is rejected). (#private-config params)
//
// windowDays: only terminal outcomes in the last N days count toward the signal (recency-aware).
// minSample counts only the quality-relevant buckets (success + quality_fail[+light] + prompt_injection),
//   i.e. it EXCLUDES conflict/out-of-band/manual rows — a sample below the floor is always 'neutral'.
// qualityFailLowRate / qualityFailLowMaxSuccess: serial quality-failure → 'low' needs a HIGH genuine-fail rate
//   AND very few successes (the success guard — a high-volume contributor with recent merges is NEVER 'low').
// lightFailWeight: the light bucket (flaky CI + honest-collision/transient-fetch) counts at this fraction of a
//   genuine reviewer reject, so duplicates/unfetchable closes alone can't brand someone (#reputation-too-harsh).
// trustedMinSuccess / trustedMaxFailRate: 'trusted' needs solid recent successes AND a low effective fail rate.

/** The committed, behavior-preserving defaults (the historical hardcoded constants). A private `reputation`
 *  override replaces individual fields fail-safe (never loosening the gate); omit → these apply. */
export const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  windowDays: REPUTATION_WINDOW_DAYS,
  minSample: 5,
  qualityFailLowRate: 0.7,
  qualityFailLowMaxSuccess: 2, // "very few" recent merges
  lightFailWeight: 0.5,
  trustedMinSuccess: 5,
  trustedMaxFailRate: 0.2,
};

/** Derive the reputation signal from the recency-windowed, quality-classified bucket counts. Pure + total.
 *  Thresholds default to DEFAULT_REPUTATION_CONFIG (behavior-preserving); a deployment may tune them privately. */
export function signalFromCounts(c: ReputationCounts, cfg: ReputationConfig = DEFAULT_REPUTATION_CONFIG): ReputationSignal {
  // Effective (weighted) genuine-fail count: full-weight reviewer rejects + half-weight light signals (flaky
  // CI + honest-collision / transient-fetch). Prompt-injection is handled separately (its own hard rule).
  const weightedFails = c.qualityFail + c.qualityFailLight * cfg.lightFailWeight;
  // The quality-relevant sample (excludes conflicts/out-of-band/manual — those never reach here).
  const sample = c.success + c.qualityFail + c.qualityFailLight + c.promptInjection;
  if (sample < cfg.minSample) return "neutral";

  // ── 'low' — genuine malice: ANY prompt-injection (the single hard-abuse signal). ──
  if (c.promptInjection > 0) return "low";
  // ── 'low' — serial quality-failure: a high genuine-fail rate AND very few successes. A high-volume
  // contributor with a healthy number of recent merges fails this (success guard) and stays 'neutral'. The
  // soft signals (duplicates/unfetchable) only count at half weight here, so they can't brand alone. ──
  const failRate = sample > 0 ? weightedFails / sample : 0;
  if (failRate >= cfg.qualityFailLowRate && c.success < cfg.qualityFailLowMaxSuccess) return "low";

  // ── 'trusted' — solid recent successes and a low effective fail rate. ──
  if (c.success >= cfg.trustedMinSuccess && failRate <= cfg.trustedMaxFailRate) return "trusted";

  return "neutral";
}

/** Tally a set of (status, reasonCode) rows into recency-windowed quality buckets, dropping the EXCLUDE bucket. */
export function countOutcomes(rows: Array<{ status: string; reasonCode: string | null }>): ReputationCounts {
  const c: ReputationCounts = { success: 0, qualityFail: 0, qualityFailLight: 0, promptInjection: 0 };
  for (const r of rows) {
    switch (classifyOutcome(r.status, r.reasonCode)) {
      case "success":
        c.success++;
        break;
      case "quality_fail":
        c.qualityFail++;
        break;
      case "quality_fail_light":
        c.qualityFailLight++;
        break;
      case "prompt_injection":
        c.promptInjection++;
        break;
      default:
        break; // exclude
    }
  }
  return c;
}

/** Record a terminal outcome for a submitter (internal; fail-safe no-op on any error). Keeps submitter_stats
 *  current for the operator /stats view — it is NO LONGER the source of the signal (review_targets is). */
export async function recordSubmissionOutcome(env: Env, project: string, submitter: string | undefined, outcome: SubmissionOutcome): Promise<void> {
  if (!submitter) return;
  const col = outcome === "merged" ? "merged" : outcome === "closed" ? "closed" : "manual";
  try {
    await storage(env)
      .prepare(
        `INSERT INTO submitter_stats (project, submitter, submissions, ${col}, last_seen) VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(project, submitter) DO UPDATE SET submissions = submitter_stats.submissions + 1, ${col} = submitter_stats.${col} + 1, last_seen = CURRENT_TIMESTAMP`,
      )
      .bind(project, submitter)
      .run();
  } catch (error) {
    console.log(JSON.stringify({ event: "reputation_record_error", message: String(error).slice(0, 150) }));
  }
}

/** Read a submitter's internal reputation. The SIGNAL is derived from review_targets over the recency window
 *  (quality-weighted, conflict-excluded); the all-time counts come from submitter_stats for the /stats view.
 *  Fail-safe → "neutral" on ANY error (it must never throw into the gate). */
export async function getSubmitterReputation(env: Env, project: string, submitter: string | undefined, cfg: ReputationConfig = DEFAULT_REPUTATION_CONFIG): Promise<SubmitterStats> {
  const neutral: SubmitterStats = { submissions: 0, merged: 0, closed: 0, manual: 0, closeRate: 0, signal: "neutral" };
  if (!submitter) return neutral;
  // The all-time aggregate counts (for /stats only — NOT the signal). Best-effort: a failure here still lets the
  // signal derive (and vice-versa); either failing degrades to neutral defaults, never throws.
  let agg = { submissions: 0, merged: 0, closed: 0, manual: 0 };
  try {
    const row = await storage(env)
      .prepare("SELECT submissions, merged, closed, manual FROM submitter_stats WHERE project = ? AND submitter = ?")
      .bind(project, submitter)
      .first<{ submissions: number; merged: number; closed: number; manual: number }>();
    if (row) agg = { submissions: row.submissions, merged: row.merged, closed: row.closed, manual: row.manual };
  } catch {
    // keep neutral aggregate defaults
  }

  let signal: ReputationSignal = "neutral";
  try {
    const result = await storage(env)
      .prepare(
        `SELECT status, json_extract(decision_json, '$.reasonCode') AS reasonCode
           FROM review_targets
          WHERE project = ? AND submitter = ? AND terminal_at IS NOT NULL AND terminal_at >= datetime('now', ?)
          ORDER BY terminal_at DESC LIMIT ?`,
      )
      .bind(project, submitter, `-${cfg.windowDays} days`, REPUTATION_WINDOW_ROW_CAP)
      .all<{ status: string; reasonCode: string | null }>();
    const rows = result?.results ?? [];
    signal = signalFromCounts(countOutcomes(rows), cfg);
  } catch {
    signal = "neutral"; // fail-safe — never throw into the gate.
  }

  const decided = agg.merged + agg.closed;
  return { ...agg, closeRate: decided > 0 ? agg.closed / decided : 0, signal };
}

/** Install-wide sibling of {@link getSubmitterReputation} (#4513): the SAME quality-weighted, recency-windowed
 *  signal derivation, but aggregated across EVERY repo `review_targets` has recorded for this installation_id
 *  (migrations/0050), not just one project. Closes a real blind spot: a fleet identity spreading thin across
 *  many repos in one self-hosted install never accumulates same-repo sample density for the per-project
 *  signal to ever leave "neutral," even while it burns full paid AI-review spend on every submission. Callers
 *  should reserve this for a CONFIRMED official Gittensor miner identity (this function does not itself check
 *  that) -- an ordinary contributor's reputation stays intentionally scoped per-repo. The all-time
 *  submitter_stats aggregate (submissions/merged/closed/manual, /stats-view only, not the signal) is NOT
 *  widened here: that table is keyed (project, submitter) with no installation_id column, and only the
 *  SIGNAL — not the display counts — gates the AI-spend decision. Fail-safe: any read error degrades to
 *  "neutral", identical to the per-project function. */
export async function getSubmitterReputationAcrossInstall(
  env: Env,
  installationId: number,
  submitter: string | undefined,
  cfg: ReputationConfig = DEFAULT_REPUTATION_CONFIG,
): Promise<SubmitterStats> {
  const neutral: SubmitterStats = { submissions: 0, merged: 0, closed: 0, manual: 0, closeRate: 0, signal: "neutral" };
  if (!submitter) return neutral;
  let signal: ReputationSignal = "neutral";
  try {
    const result = await storage(env)
      .prepare(
        `SELECT status, json_extract(decision_json, '$.reasonCode') AS reasonCode
           FROM review_targets
          WHERE installation_id = ? AND submitter = ? AND terminal_at IS NOT NULL AND terminal_at >= datetime('now', ?)
          ORDER BY terminal_at DESC LIMIT ?`,
      )
      .bind(installationId, submitter, `-${cfg.windowDays} days`, REPUTATION_WINDOW_ROW_CAP)
      .all<{ status: string; reasonCode: string | null }>();
    /* v8 ignore next -- D1's .all() always populates results; the fallback only protects a driver anomaly. */
    const rows = result?.results ?? [];
    signal = signalFromCounts(countOutcomes(rows), cfg);
  } catch {
    signal = "neutral"; // fail-safe — never throw into the gate.
  }
  return { ...neutral, signal };
}
