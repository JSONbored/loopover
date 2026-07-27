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
// The new signal is QUALITY-weighted + RECENCY-aware: it classifies each terminal outcome by its reasonCode
// over a RECENT WINDOW, IGNORES conflict / out-of-band artifacts, and only brands "low" on CLEAR, RECENT,
// genuine abuse or serial quality-failure. The reputation signal ONLY routes to manual review (it NEVER
// closes), so we default GENEROUS to keep auto-merge flowing — old closes age out of the window and trapped
// contributors auto-correct with no migration. recordSubmissionOutcome still maintains submitter_stats for
// /stats, but the SIGNAL below is derived from the live ledgers (see #9136).
//
// #9136: the quality signal used to read `review_targets`, which stopped receiving writes at the 2026-06-22
// self-host cutover (no live writer anywhere in this codebase — see src/db/repo-identity-rename.ts's own
// comment) — its newest row is frozen at the cutover date, so a 90-day recency window reads a shrinking set
// that goes permanently empty around 2026-09-20. Repointed onto the SAME live ledgers getSubmitterCadence
// (#9015) already reads, mirroring that repoint: `review_audit`'s `pr_outcome` rows (outcomes-wire.ts,
// written on every realized merge/close — the ground truth, not just the bot's own prediction) joined to
// `pull_requests` for the submitter's login (review_audit carries no author identity of its own), with the
// reasonCode pulled from that same target's latest `gate_decision` row (mirrors resolveDispositionReason's
// own lookup). A target can carry more than one `pr_outcome` row in practice (recordPrOutcome's webhook path
// has no existence check unlike recordTerminalActionOutcome's direct-write path, so a redelivered `closed`
// webhook can double-insert) — every query below reads only the LATEST `pr_outcome` per target_id so a
// duplicate never double-counts one PR's outcome.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→loopover convergence): every type + helper this module needs is
// defined HERE. No imports from reviewbot — the reviewbot `storage(env)` adapter is inlined as `env.DB`, and
// the `Env` / `ReputationConfig` types are declared locally. The CLASSIFY/SIGNAL/COUNT logic is byte-faithful
// to the reviewbot source (src/core/submitter-reputation.ts); the only deltas are mechanical guards for
// loopover's stricter tsconfig (noUncheckedIndexedAccess / exactOptionalPropertyTypes), which don't change
// behavior.

// ── Inlined minimal deps (no reviewbot imports) ─────────────────────────────────────────────────────────

/** The D1 binding this module reads/writes. `Env` is loopover's global ambient interface (env.DB: D1Database);
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
    // #9015: reads the LIVE ledger. This query previously read `review_targets`, which stopped receiving
    // writes at the 2026-06-22 self-host cutover — the cadence leg was silently inert (newest row frozen at
    // the cutover date), so the machine-paced signal never fired for any submitter. `pull_requests` is the
    // live per-PR table the same pipeline maintains; `created_at` is its ingest timestamp, which is what a
    // SUBMISSION cadence is about.
    const result = await storage(env)
      .prepare(`SELECT created_at AS createdAt FROM pull_requests WHERE repo_full_name = ? AND LOWER(author_login) = LOWER(?) AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?`)
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

  // ── 'low' — genuine malice: ANY prompt-injection (the single hard-abuse signal). This is an
  // unconditional hard override, so it precedes the minSample guard below: a brand-new, low-history
  // account attempting a single prompt injection is precisely the worst case it exists to catch, and
  // it must not be masked by the small-sample "neutral" shortcut. ──
  if (c.promptInjection > 0) return "low";

  if (sample < cfg.minSample) return "neutral";
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

/**
 * Record a terminal outcome for a submitter (internal; fail-safe no-op on any error). Keeps submitter_stats
 * current for the operator /stats view — it is NO LONGER the source of the signal (review_targets is).
 *
 * #9131: idempotent per (project, submitter, pullNumber, outcome) via submitter_outcome_log. The prior
 * shape counted webhook PASSES, not submissions — every re-gate of the SAME PR (a body edit, a push, or a
 * third party's review comment on a rival's held PR) bumped the counter again, with no idempotency key at
 * all. `INSERT OR IGNORE` into the log first; the submitter_stats increment only runs when that insert
 * actually created a row, so N re-gates of one PR (or N adversarial comments on it) yield exactly one
 * counted outcome — including "manual", which used to accrue once per re-gate of a still-open, held PR.
 */
export async function recordSubmissionOutcome(env: Env, project: string, submitter: string | undefined, pullNumber: number, outcome: SubmissionOutcome): Promise<void> {
  if (!submitter) return;
  const col = outcome === "merged" ? "merged" : outcome === "closed" ? "closed" : "manual";
  try {
    const logged = await storage(env)
      .prepare(`INSERT OR IGNORE INTO submitter_outcome_log (project, submitter, pull_number, outcome) VALUES (?, ?, ?, ?)`)
      .bind(project, submitter, pullNumber, outcome)
      .run();
    if (logged.meta.changes === 0) return; // already counted this exact (project, submitter, PR, outcome)
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

// ── #9136 live-ledger source fragments (shared by every quality-signal query below) ──────────────────────
//
// review_audit carries no author identity of its own (see this file's header comment) -- `pr.number` is
// recovered from `po.target_id` (`project#number`, reviewAuditTargetId in outcomes-wire.ts) via string
// concatenation rather than a stored column, since `project` IS `pr.repo_full_name` for every native writer
// (parity-wire.ts / outcomes-wire.ts both pass `repoFullName` as `project`).
const PR_OUTCOME_JOIN = `JOIN pull_requests pr ON pr.repo_full_name = po.project AND (po.project || '#' || pr.number) = po.target_id`;

// A target can carry more than one `pr_outcome` row in practice (recordPrOutcome's webhook path has no
// existence check unlike recordTerminalActionOutcome's direct-write path, so a redelivered `closed` webhook
// can double-insert) -- restrict to each target's LATEST `pr_outcome` row so a duplicate never double-counts.
const LATEST_PR_OUTCOME_FILTER = `po.event_type = 'pr_outcome'
     AND po.created_at = (
       SELECT MAX(po2.created_at) FROM review_audit po2
       WHERE po2.target_id = po.target_id AND po2.event_type = 'pr_outcome'
     )`;

// The reasonCode a pr_outcome row's OWN bot decision recorded, if any -- a pr_outcome row never carries a
// summary itself (appendReviewAudit's default), only a gate_decision row does. Mirrors
// resolveDispositionReason's own "latest gate_decision summary for this target" lookup (outcomes-wire.ts).
const REASON_CODE_SUBQUERY = `(
      SELECT gd.summary FROM review_audit gd
      WHERE gd.target_id = po.target_id AND gd.event_type = 'gate_decision' AND gd.summary IS NOT NULL
      ORDER BY gd.created_at DESC LIMIT 1
    )`;

/** Read a submitter's internal reputation. The SIGNAL is derived from review_targets over the recency window
 *  (quality-weighted, conflict-excluded); the all-time counts come from submitter_stats for the /stats view.
 *  Fail-safe → "neutral" on ANY error (it must never throw into the gate). */
export async function getSubmitterReputation(env: Env, project: string, submitter: string | undefined, cfg: ReputationConfig = DEFAULT_REPUTATION_CONFIG): Promise<SubmitterStats> {
  const neutral: SubmitterStats = { submissions: 0, merged: 0, closed: 0, manual: 0, closeRate: 0, signal: "neutral" };
  if (!submitter) return neutral;
  // #9131: WINDOWED (not all-time) counts, read from the idempotent submitter_outcome_log rather than
  // submitter_stats -- so a burst state DECAYS as old outcomes age out of the window, instead of a serial
  // false-positive from months ago permanently gating this submitter with no recovery but a merge. The
  // all-time submitter_stats table still exists and is still maintained (recordSubmissionOutcome), but only
  // for the separate /stats operator view (src/review/contributor-trust-profile.ts reads it directly) --
  // nothing that feeds a gate decision should read an undecaying aggregate. Best-effort: a failure here
  // still lets the signal derive (and vice-versa); either failing degrades to neutral defaults, never throws.
  let agg = { submissions: 0, merged: 0, closed: 0, manual: 0 };
  try {
    const row = await storage(env)
      .prepare(
        `SELECT COUNT(*) AS submissions,
                SUM(CASE WHEN outcome = 'merged' THEN 1 ELSE 0 END) AS merged,
                SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN outcome = 'manual' THEN 1 ELSE 0 END) AS manual
           FROM submitter_outcome_log
          WHERE project = ? AND submitter = ? AND recorded_at >= datetime('now', ?)`,
      )
      .bind(project, submitter, `-${cfg.windowDays} days`)
      .first<{ submissions: number; merged: number | null; closed: number | null; manual: number | null }>();
    // A submitter with zero rows in the window is a real, common case (SUM over an empty set is NULL, COUNT
    // is 0) -- ?? 0 on each SUM column, not just a truthy-row check, or a genuinely-neutral submitter would
    // read `merged: null` and corrupt closeRate's arithmetic below.
    if (row) agg = { submissions: row.submissions, merged: row.merged ?? 0, closed: row.closed ?? 0, manual: row.manual ?? 0 };
  } catch {
    // keep neutral aggregate defaults
  }

  let signal: ReputationSignal = "neutral";
  try {
    // #9136: repointed off review_targets (frozen since the 2026-06-22 cutover) onto the live review_audit
    // pr_outcome ledger -- see this file's header comment + the shared fragments above for the full shape.
    const result = await storage(env)
      .prepare(
        `SELECT po.decision AS status, ${REASON_CODE_SUBQUERY} AS reasonCode
           FROM review_audit po
           ${PR_OUTCOME_JOIN}
          WHERE po.project = ? AND LOWER(pr.author_login) = LOWER(?) AND ${LATEST_PR_OUTCOME_FILTER}
            AND po.created_at >= datetime('now', ?)
          ORDER BY po.created_at DESC LIMIT ?`,
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

/** One submitter's raw, recency-windowed terminal-outcome tally for a repo (#6488) — the same live-ledger
 *  source {@link getSubmitterReputation} reads, but grouped by submitter instead of scoped to one.
 *  `avgAttemptCount` (#9136): the pre-repoint source (`review_targets.attempt_count`, the gate's own
 *  re-review counter) has no live equivalent — `pull_requests.merge_attempt_count` is the closest LIVE
 *  per-PR retry counter, but it is narrower (only FAILED merge attempts — permission/check/conflict — reset
 *  per head SHA; see its own schema comment), not every re-review cycle. Documented substitution, not a
 *  fabricated value: still a genuine review-friction signal, just not byte-identical in meaning to the
 *  pre-cutover figure. `avgMergeMs` is `AVG(merged_at - created_at)` over MERGED rows only, sourced from
 *  `pull_requests`' own timestamps (`null` when this submitter has no merges in the window). */
export interface SubmitterCohortRow {
  submitter: string;
  submissions: number;
  merged: number;
  closed: number;
  avgAttemptCount: number;
  avgMergeMs: number | null;
}

/** Per-submitter cohort tally for a repo over the recency window (#6488, AMS-vs-human dashboard comparison).
 *  Reuses the SAME live review_audit pr_outcome ledger {@link getSubmitterReputation} does (#9136), just
 *  grouped by submitter instead of read for one. Fail-safe: any read error degrades to an empty array (never
 *  throws — the caller treats that identically to "no activity in the window"). */
export async function listSubmitterCohortRows(env: Env, project: string, windowDays: number = REPUTATION_WINDOW_DAYS): Promise<SubmitterCohortRow[]> {
  try {
    const result = await storage(env)
      .prepare(
        `SELECT pr.author_login AS submitter,
                COUNT(*) AS submissions,
                SUM(CASE WHEN po.decision = 'merged' THEN 1 ELSE 0 END) AS merged,
                SUM(CASE WHEN po.decision = 'closed' THEN 1 ELSE 0 END) AS closed,
                AVG(pr.merge_attempt_count) AS avgAttemptCount,
                AVG(CASE WHEN po.decision = 'merged' AND pr.merged_at IS NOT NULL THEN (julianday(pr.merged_at) - julianday(pr.created_at)) * 86400000 ELSE NULL END) AS avgMergeMs
           FROM review_audit po
           ${PR_OUTCOME_JOIN}
          WHERE po.project = ? AND pr.author_login IS NOT NULL AND pr.author_login != '' AND ${LATEST_PR_OUTCOME_FILTER}
            AND po.created_at >= datetime('now', ?)
          GROUP BY submitter`,
      )
      .bind(project, `-${windowDays} days`)
      .all<{ submitter: string; submissions: number; merged: number; closed: number; avgAttemptCount: number; avgMergeMs: number | null }>();
    return (result?.results ?? []).map((row) => ({
      submitter: row.submitter,
      submissions: row.submissions,
      merged: row.merged,
      closed: row.closed,
      avgAttemptCount: row.avgAttemptCount,
      avgMergeMs: row.avgMergeMs,
    }));
  } catch {
    return []; // fail-safe — never throw; the caller reads this identically to "no activity in the window".
  }
}

/** Install-wide sibling of {@link getSubmitterReputation} (#4513): the SAME quality-weighted, recency-windowed
 *  signal derivation, but aggregated across EVERY repo the live ledgers have recorded for this
 *  installation_id (the `repositories` table's own `installation_id` column), not just one project. Closes a
 *  real blind spot: a fleet identity spreading thin across many repos in one self-hosted install never
 *  accumulates same-repo sample density for the per-project signal to ever leave "neutral," even while it
 *  burns full paid AI-review spend on every submission. Callers should reserve this for a CONFIRMED official
 *  Gittensor miner identity (this function does not itself check that) -- an ordinary contributor's
 *  reputation stays intentionally scoped per-repo. The all-time submitter_stats aggregate
 *  (submissions/merged/closed/manual, /stats-view only, not the signal) is NOT widened here: that table is
 *  keyed (project, submitter) with no installation_id column, and only the SIGNAL — not the display counts —
 *  gates the AI-spend decision. Fail-safe: any read error degrades to "neutral", identical to the per-project
 *  function. #9136: repointed off review_targets onto the same live review_audit pr_outcome ledger as
 *  {@link getSubmitterReputation}, joined through `repositories` to resolve `project` (repo_full_name) →
 *  installation_id (review_audit itself carries no installation scope). */
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
        `SELECT po.decision AS status, ${REASON_CODE_SUBQUERY} AS reasonCode
           FROM review_audit po
           ${PR_OUTCOME_JOIN}
           JOIN repositories r ON r.full_name = po.project
          WHERE r.installation_id = ? AND LOWER(pr.author_login) = LOWER(?) AND ${LATEST_PR_OUTCOME_FILTER}
            AND po.created_at >= datetime('now', ?)
          ORDER BY po.created_at DESC LIMIT ?`,
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
