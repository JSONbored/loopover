import { nowIso } from "../utils/json";

/**
 * Data-retention policy for the high-volume, append-only / log / superseded-snapshot tables. These hold
 * pure history (logs, usage metrics, ephemeral observations, webhook delivery traces) or snapshots where
 * only the latest matters, so rows older than the window can be safely deleted. Current-state and reference
 * tables (repositories, repository_settings, pull_requests, issues, contributors, registry/scoring snapshots,
 * repository_ai_keys, focus manifests, etc.) are intentionally EXCLUDED — they are not append-only logs.
 *
 * `column` is the row's primary timestamp (ISO-8601). Windows are deliberately conservative.
 */
export type RetentionRule = { table: string; column: string; days: number };

const DURABLE_AUDIT_EVENT_TYPES = ["github_app.pr_public_surface_published"] as const;

export const RETENTION_POLICY: readonly RetentionRule[] = [
  // #9474: MUST stay ahead of audit_events. This table's prune first FOLDS the rows it is about to delete
  // into the durable orb_outcome_rollups running totals (see pruneExpiredRecords' special case), and that
  // fold reuses getOrbGlobalStats' exact counting semantics -- including the LEFT JOIN that excludes
  // outcomes whose PR already published a review surface (a durable audit_events row). Both tables share a
  // 90-day window, so if audit_events pruned first within the same pass, the very audit rows that exclusion
  // needs would be gone by the time the fold ran, and the rollup would permanently over-count exactly the
  // PRs the live query never counted.
  { table: "orb_pr_outcomes", column: "occurred_at", days: 90 },
  { table: "audit_events", column: "created_at", days: 90 },
  { table: "ai_usage_events", column: "created_at", days: 90 },
  { table: "product_usage_events", column: "occurred_at", days: 180 },
  { table: "github_rate_limit_observations", column: "observed_at", days: 30 },
  { table: "signal_snapshots", column: "generated_at", days: 90 },
  { table: "score_previews", column: "generated_at", days: 90 },
  { table: "repo_snapshots", column: "fetched_at", days: 90 },
  // One payloadJson blob per agent run (#3896); a per-run diagnostic snapshot with no cross-run rollup
  // depending on it, so a shorter window than the audit/usage-log tables above is appropriate.
  { table: "agent_context_snapshots", column: "created_at", days: 30 },
  // One row per inbound webhook delivery (#8381 / unfinished #3896); short-lived idempotency lookups,
  // not durable history. Cut 90d -> 14d: the dedup lookups these serve are minutes-old at most, and at the
  // hosted fleet's ~4.3M-rows/day write rate a 90-day window on a pure idempotency log is the single
  // largest avoidable contributor to the D1 ceiling (see the block at the end of this policy).
  { table: "webhook_events", column: "received_at", days: 14 },
  // One row per outbound notification delivery (#8899); same append-only log shape as webhook_events.
  { table: "notification_deliveries", column: "created_at", days: 90 },
  // #9138: one row per loopover_predict_gate/explain_gate_disposition MCP call (unbounded, contributor-
  // driven growth -- predicted-gate-calls.ts deliberately never dedups at write time, see that file's own
  // header comment) -- same 90-day append-only-log window as audit_events/ai_usage_events above.
  { table: "predicted_gate_calls", column: "created_at", days: 90 },
  // #9083: four read-side caches with a TTL enforced only at the READ site (getCachedGroundingFileContent /
  // getCachedAiReview / getCachedAiSlopFinding / getCachedLinkedIssueSatisfaction) and NO delete path at
  // all -- every row lives forever once written. grounding_file_content_cache keys on (repo, path,
  // head_sha), so every push mints a fresh head_sha and permanently strands the prior push's blobs (a 20-push
  // PR with 15 files leaves 300 dead rows) -- hence the much shorter 2-day window (its own read-side TTL is
  // 24h, so 2 days never deletes a row a read could still legitimately hit). The other three key on
  // (repo, pull, head_sha[, ...]) with the same "new head_sha orphans the old row" shape but a lower
  // per-row footprint (JSON, not file bodies), so they get the same 30-day window as the other
  // moderate-volume caches.
  { table: "grounding_file_content_cache", column: "fetched_at", days: 2 },
  { table: "ai_review_cache", column: "created_at", days: 30 },
  { table: "ai_slop_cache", column: "created_at", days: 30 },
  { table: "linked_issue_satisfaction_cache", column: "created_at", days: 30 },
  // #9083: shadow-parity audit trail (src/review/parity.ts) -- pure history once a decision is recorded,
  // same append-only-log shape and window as audit_events/webhook_events.
  { table: "review_audit", column: "created_at", days: 90 },
  // #9083: content-addressed decision records (#8836) are a contributor's evidentiary trail for "clause X
  // closed me" -- kept longer than the plain operational logs above so a dispute raised weeks after a
  // close still has its record, matching product_usage_events' 180-day window for the same reason.
  { table: "decision_records", column: "created_at", days: 180 },
  // #9083: the central Orb App's OWN webhook delivery/dedup log (separate from webhook_events, which is the
  // per-repo review app's) -- identical short-lived-idempotency shape, same 14d window as webhook_events.
  { table: "orb_webhook_events", column: "received_at", days: 14 },
  // The five highest-growth tables below had NO retention rule at all and grew without bound, which is what
  // actually filled the hosted D1 to its 10GB ceiling: every write then failed with
  // `D1_ERROR: Exceeded maximum DB size`, including recordOrbWebhookEvent's INSERT, so /v1/orb/webhook
  // returned 500 to GitHub and inbound webhook delivery stopped fleet-wide until rows were pruned by hand.
  // Measured at the time of the outage: check_summaries 100,459 rows / 0.30GB of payload_json and
  // pull_request_files 54,532 rows / 0.20GB were the two largest single consumers in the database.
  //
  // All five are re-derivable GitHub mirrors or superseded snapshots, never a contributor's evidentiary
  // trail (decision_records, 180d above, is the table that carries that): a check-run summary, a PR's file
  // list, a repo's totals snapshot, and the merged-PR/outcome caches are all re-fetched from GitHub on the
  // next sync of the PR that needs them. 30 days keeps every window the review paths actually read
  // (grounding/impact-map reads are head_sha-scoped and days-fresh at most) while bounding the growth.
  { table: "check_summaries", column: "updated_at", days: 30 },
  { table: "pull_request_files", column: "updated_at", days: 30 },
  { table: "repo_github_totals_snapshots", column: "fetched_at", days: 30 },
  { table: "recent_merged_pull_requests", column: "updated_at", days: 30 },
  // orb_pr_outcomes was #9415's fifth entry here; #9474 moved it to the TOP of this policy (ordering
  // constraint documented there) and gave it a fold-before-delete so the cumulative public counter it
  // feeds can never shrink.
  // #9473: four more members of the same re-derivable/per-event class #9415 bounded, found by an audit sweep
  // for tables written per event with NO delete path anywhere in src/. Two have a pruned sibling, which is
  // what makes the omission clearly unintentional rather than a retention decision:
  //   - pull_request_reviews is the SIXTH GitHub mirror alongside pull_request_files/check_summaries above,
  //     synced by the same backfill segment machinery and re-fetched on the next sync.
  //   - predicted_gate_calibration_ledger is per (login, project, PR, COMMIT); its sibling
  //     predicted_gate_calls is already pruned at 90d.
  //   - contributor_gate_history is per (login, project, PR, HEAD_SHA), so every push adds a row, and every
  //     reader is already windowed (contributor-gate-eval / predicted-gate-agreement both use created_at >= ?)
  //     -- aged rows are pure dead weight.
  //   - decision_replay_inputs holds one replay_json blob per decision record, whose parent decision_records
  //     is pruned at 180d above; without a matching rule these rows outlive the thing they describe.
  { table: "pull_request_reviews", column: "updated_at", days: 30 },
  { table: "predicted_gate_calibration_ledger", column: "created_at", days: 90 },
  { table: "contributor_gate_history", column: "created_at", days: 90 },
  { table: "decision_replay_inputs", column: "created_at", days: 180 },
];

// #9083: a real, single-column, indexable primary key for the ordered-range delete below, keyed by table
// name -- NOT the SQLite rowid / Postgres ctid pseudo-column pruneExpiredRecords used to delete by
// exclusively. ctid is a physical row locator, not a value an index can be built over, so
// `ctid IN (SELECT ctid ... LIMIT n)` forces Postgres to Seq-Scan the ENTIRE outer table for every batch
// (the TID-scan fast path only fires for a constant qual, not a correlated subquery) -- on a
// multi-hundred-thousand-row table that scan alone can exceed prune-retention's 30-minute job timeout,
// permanently stalling retention. Every table above with a genuine single-column id gets that column here,
// paired with a leading index on its retention timestamp column (see the accompanying migration) so the
// inner SELECT is an index range scan, not a scan of its own. A table absent from this map (a composite
// primary key, or a caller-supplied ad-hoc rule in a test) falls back to rowid/ctid -- still correct, just
// not scan-optimal, which is acceptable for the lower row counts of the tables that fall back today.
export const RETENTION_PK_COLUMN: Readonly<Record<string, string>> = {
  audit_events: "id",
  ai_usage_events: "id",
  product_usage_events: "id",
  github_rate_limit_observations: "id",
  signal_snapshots: "id",
  score_previews: "id",
  repo_snapshots: "id",
  agent_context_snapshots: "id",
  webhook_events: "delivery_id",
  notification_deliveries: "id",
  predicted_gate_calls: "id",
  review_audit: "id",
  decision_records: "id",
  orb_webhook_events: "delivery_id",
  // #9472: #9415 added the five tables below to RETENTION_POLICY but not here, so pkColumnFor() fell back to
  // `rowid` -- which pg-dialect rewrites to `ctid`, turning each batched delete's outer `IN` into a full
  // sequential scan of the whole table, hourly. All five have a single-column `id TEXT PRIMARY KEY`.
  check_summaries: "id",
  pull_request_files: "id",
  repo_github_totals_snapshots: "id",
  recent_merged_pull_requests: "id",
  // #9473's additions carry their own single-column primary keys for the same reason.
  pull_request_reviews: "id",
  predicted_gate_calibration_ledger: "id",
  contributor_gate_history: "id",
  // decision_replay_inputs keys on record_id (decision_records.id), not an `id` column.
  decision_replay_inputs: "record_id",
};

/**
 * Policy tables that legitimately have NO single-column primary key, so {@link RETENTION_PK_COLUMN} cannot
 * name one and pkColumnFor() falls back to `rowid` for them. Listing them explicitly (rather than letting an
 * absence mean either "composite PK" or "someone forgot") is what lets the completeness guard in
 * test/unit/retention.test.ts be strict: every policy table must appear in one of the two, so a new entry
 * cannot ship unmapped by accident the way #9415's five did.
 *
 * NOTE the cost of being here: on the self-host Postgres backend `rowid` is rewritten to `ctid`, so the
 * batched delete's outer `IN` is a sequential scan of the whole table. The retention-column index from
 * 0193/0196 still serves the inner SELECT, so the scan is bounded by batch size rather than table size, but a
 * future table with a genuinely high row count should prefer adding a surrogate `id` over joining this list.
 */
export const RETENTION_COMPOSITE_PK_TABLES: ReadonlySet<string> = new Set([
  // PRIMARY KEY (repository_full_name, pr_number)
  "orb_pr_outcomes",
  // PRIMARY KEY (repo_full_name, path, head_sha)
  "grounding_file_content_cache",
  // PRIMARY KEY (repo_full_name, pull_number, head_sha[, linked_issue_number])
  "ai_review_cache",
  "ai_slop_cache",
  "linked_issue_satisfaction_cache",
]);

/**
 * The retention cutoff for `table` as of `nowMs` -- rows with a timestamp strictly BELOW this are eligible
 * for pruning -- or null when the table has no retention rule at all. #9474: exported so consumers whose
 * correctness depends on a table's permanence can reason about its IMPERMANENCE instead of silently assuming.
 * verifyDecisionLedger uses this to tell "this record was legitimately pruned by the published retention
 * policy" apart from "this record is missing and should not be": the distinction is keyed on the LEDGER row's
 * hash-chained created_at (which cannot be backdated without breaking the chain), so an operator cannot use
 * the tolerance to hide a fresh deletion.
 */
export function retentionCutoffIsoForTable(table: string, nowMs: number = Date.parse(nowIso())): string | null {
  const rule = RETENTION_POLICY.find((candidate) => candidate.table === table);
  return rule ? cutoffIso(rule.days, nowMs) : null;
}

function pkColumnFor(table: string): string {
  return RETENTION_PK_COLUMN[table] ?? "rowid";
}

export type PruneResult = { table: string; column: string; cutoff: string; deleted: number };

const SAFE_IDENTIFIER = /^[a-z_]+$/;
const BATCH_SIZE = 1000;
// Bound work per table per run so a first prune of a large backlog cannot blow the D1 statement budget;
// the cron drains any remainder over subsequent runs.
//
// Raised 50k -> 250k because the old ceiling made retention structurally unable to keep up on the hosted
// fleet and so guaranteed the D1 ceiling would be reached eventually: at 50k/table against a measured
// ~4.3M rows written per day, a DAILY prune could delete at most ~1.25M rows/day across the whole policy —
// a permanent ~3.5x deficit that no window tightening alone can close, because the cap (not the cutoff)
// was the binding constraint. Paired with the hourly cadence in src/index.ts, the policy now drains far
// faster than the fleet writes, so a backlog converges instead of compounding.
const MAX_DELETED_PER_TABLE = 250_000;
const MS_PER_DAY = 86_400_000;

function retentionWhere(rule: RetentionRule): string {
  // Anonymous `?` — node:sqlite DatabaseSync rejects numbered `?1` binds with "column index out of range".
  const base = `${rule.column} < ?`;
  if (rule.table === "audit_events") {
    const durableTypes = DURABLE_AUDIT_EVENT_TYPES.map((type) => `'${type}'`).join(", ");
    return `${base} AND event_type NOT IN (${durableTypes})`;
  }
  return base;
}

function cutoffIso(days: number, nowMs: number): string {
  return new Date(nowMs - days * MS_PER_DAY).toISOString();
}

/**
 * Delete (or, in dry-run, count) rows older than each table's retention window. Returns per-table results.
 * Table/column names come only from the hardcoded {@link RETENTION_POLICY} (never user input) and are
 * identifier-validated defensively; the cutoff is bound as a parameter. Deletes run in bounded batches.
 */
export async function pruneExpiredRecords(
  env: Env,
  options: { dryRun?: boolean; nowMs?: number; policy?: readonly RetentionRule[]; batchSize?: number; maxPerTable?: number } = {},
): Promise<PruneResult[]> {
  const dryRun = options.dryRun ?? false;
  const nowMs = options.nowMs ?? Date.parse(nowIso());
  const policy = options.policy ?? RETENTION_POLICY;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPerTable = options.maxPerTable ?? MAX_DELETED_PER_TABLE;
  const results: PruneResult[] = [];

  for (const rule of policy) {
    if (!SAFE_IDENTIFIER.test(rule.table) || !SAFE_IDENTIFIER.test(rule.column)) {
      throw new Error(`Unsafe retention identifier: ${rule.table}.${rule.column}`);
    }
    const cutoff = cutoffIso(rule.days, nowMs);

    if (dryRun) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${rule.table} WHERE ${retentionWhere(rule)}`).bind(cutoff).first<{ n: number }>();
      results.push({ table: rule.table, column: rule.column, cutoff, deleted: Number(row?.n ?? 0) });
      continue;
    }

    // #9474: orb_pr_outcomes feeds a CUMULATIVE public counter (getOrbGlobalStats -> the homepage "all-time"
    // merged/closed totals), so its rows must be folded into the durable orb_outcome_rollups totals in the
    // same transaction that deletes them -- a fold and delete that could commit separately would either
    // double-count (fold landed, delete didn't, next run re-folds) or under-count (delete landed, fold
    // didn't). One atomic batch, both statements scoped to the identical cutoff, sidesteps both. The delete
    // is deliberately UNBATCHED for this one table: the aging cohort is one row per fleet-wide PR terminal
    // per day (hundreds at most, vs the six-figure log tables the batching exists for), and a bounded delete
    // would reintroduce the split-commit problem for whatever the bound left behind.
    if (rule.table === "orb_pr_outcomes") {
      const batchResults = await env.DB.batch([
        // Fold EXACTLY the population getOrbGlobalStats counts: registered installations only, and only
        // outcomes whose PR never published a review surface (those are already counted by the own ledger).
        // Rows failing either filter are deleted WITHOUT folding -- the live query never counted them, so
        // folding them would make the public total jump on prune day. Keyed per lowercased account_login so
        // the stats query's excludeAccount de-dup keeps working against the rollup after the raw rows are gone.
        env.DB.prepare(
          `INSERT INTO orb_outcome_rollups (account_login, merged, closed, total, updated_at)
           SELECT LOWER(COALESCE(i.account_login, '')) AS account_login,
                  SUM(CASE WHEN o.outcome = 'merged' THEN 1 ELSE 0 END) AS merged,
                  SUM(CASE WHEN o.outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
                  COUNT(*) AS total,
                  ?2 AS updated_at
           FROM orb_pr_outcomes o
           JOIN orb_github_installations i ON i.installation_id = o.installation_id AND i.registered = 1
           LEFT JOIN audit_events ae
             ON ae.target_key = o.repository_full_name || '#' || o.pr_number
             AND ae.event_type = 'github_app.pr_public_surface_published'
           WHERE o.occurred_at < ?1 AND ae.id IS NULL
           GROUP BY LOWER(COALESCE(i.account_login, ''))
           ON CONFLICT(account_login) DO UPDATE SET
             merged = orb_outcome_rollups.merged + excluded.merged,
             closed = orb_outcome_rollups.closed + excluded.closed,
             total = orb_outcome_rollups.total + excluded.total,
             updated_at = excluded.updated_at`,
        ).bind(cutoff, nowIso()),
        env.DB.prepare(`DELETE FROM orb_pr_outcomes WHERE occurred_at < ?1`).bind(cutoff),
      ]);
      /* v8 ignore next 2 -- defensive: batch() returns exactly one result per statement on both backends, so
       * the `?.`/`?? 0` arms only satisfy the driver types; a missing meta degrades the COUNT, never the prune. */
      results.push({ table: rule.table, column: rule.column, cutoff, deleted: Number(batchResults[1]?.meta?.changes ?? 0) });
      continue;
    }

    let deleted = 0;
    // Batched delete by a real indexable PK (see RETENTION_PK_COLUMN) ordered by the retention column, so
    // each statement is bounded AND the inner SELECT is an index range scan on Postgres, not a ctid-keyed
    // correlated subquery that forces a full seq scan of the outer table (#9083).
    const pk = pkColumnFor(rule.table);
    for (;;) {
      const result = await env.DB.prepare(
        `DELETE FROM ${rule.table} WHERE ${pk} IN (SELECT ${pk} FROM ${rule.table} WHERE ${retentionWhere(rule)} ORDER BY ${rule.column} LIMIT ${batchSize})`,
      )
        .bind(cutoff)
        .run();
      const changes = Number(result.meta?.changes ?? 0);
      deleted += changes;
      if (changes < batchSize || deleted >= maxPerTable) break;
    }
    results.push({ table: rule.table, column: rule.column, cutoff, deleted });
  }

  return results;
}

export type SignalSnapshotDedupeResult = { signalType: string; deleted: number };

/** Exported so the D1 size/row-count observability probe (#3810, src/selfhost/d1-size-probe.ts) can scope its
 *  signal_snapshots "rows per dedup key" ratio to exactly the population this dedup job converges to ~1 row
 *  per key -- NOT the whole table, which intentionally keeps bounded multi-row history for the one signal
 *  type genuinely read as a trend/change series (queue-health). Single source of truth: if this list
 *  changes, the probe's ratio scope changes with it automatically. */
export const LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES = [
  "repo-culture-profile",
  "repo-doc-refresh-attempt",
  "repo-focus-manifest",
  "repo-public-focus-manifest",
  // 2026-07-23 recurrence of #3810, new offenders: the contributor-intelligence writers (processors.ts's
  // scoring pass) append one ~36KB row PER CONTRIBUTOR PER PASS for these three types — ~6GB in three
  // weeks at current review volume, refilling D1's 10GB cap before the 90-day age window could ever
  // engage. No reader consumes them as a series (the canonical latest lives in the dedicated
  // contributor_evidence / contributor_scoring_profiles upsert tables; nothing calls
  // listSignalSnapshots for contributor-* types other than contributor-decision-pack, which itself only
  // ever reads index [0] — see below), so latest-only is lossless for every actual consumer.
  "contributor-evidence-graph",
  "contributor-outcome-history",
  "contributor-strategy",
  // #9435/#9459: 2026-07-27 recurrence, and the single largest signal_snapshots offender measured to
  // date -- 6.3 GB across 18,549 rows (~350 KB/row; the profile/outcome-history/registry-activity payload
  // each build embeds), 71% of the entire hosted D1's file size, still ENTIRELY inside the 90-day age
  // window (the database itself is only ~65 days old, so age-based pruning had not touched a single one of
  // these rows) and accumulating ~700-1,300 rows/day since 2026-07-06 -- refilling the 10GB cap from empty
  // in roughly 3-4 weeks even with the #9415 fixes applied, since those addressed five OTHER tables
  // totaling well under 1 GB combined. This entry was previously excluded by a doc comment claiming
  // decision-pack is "a bounded trend/change series by design" with volume "a fraction of" the three
  // contributor-* types above -- both claims were wrong: `src/services/decision-pack.ts`'s only reader
  // (`buildContributorDecisionPack`) calls `listSignalSnapshots(...)[0]`, exactly the same latest-only
  // contract as its neighbors, and its measured volume is ~750x theirs, not a fraction. queue-health is
  // the one signal type that genuinely IS read as a series (src/services/maintainer-slop-duplicate-trend.ts
  // shapes multiple weeks of queue-health snapshots into a trend card) and correctly stays excluded here.
  "contributor-decision-pack",
  // #8900: these eight writers also INSERT a fresh row every run (persistSignalSnapshot is not an
  // upsert) while every consumer reads only index [0] / the latest row — same latest-only contract as
  // the repo-* and contributor-intelligence types above. queue-health stays EXCLUDED (feeds
  // buildQueueTrendReport as a real series).
  "config-quality",
  "label-audit",
  "maintainer-lane",
  "maintainer-cut-readiness",
  "contributor-intake-health",
  "issue-quality",
  "repo-outcome-patterns",
  "pr-reviewability",
] as const;

/**
 * signal_snapshots has no dedup: `generate-signal-snapshots` inserts a NEW row per (signal_type,
 * target_key) on every run rather than replacing the prior one, so within RETENTION_POLICY's 90-day
 * age window a key can accumulate hundreds of superseded snapshots (#3810 -- 342,243 rows for 2,183
 * distinct keys contributed to hitting D1's size cap). Only latest-only cache signal types are
 * deduped; the one genuine historical series (queue-health) keeps its bounded RETENTION_POLICY history
 * for its trend/change reader. This keeps only the latest row per
 * (signal_type, target_key), batched PER signal_type (not one table-wide window-function delete) so
 * each statement stays within D1's per-statement CPU budget -- the same batching split used during
 * the incident's manual remediation.
 *
 * "Latest" is `(generated_at, id)` DESC per key -- NOT rowid (#9470). rowid was chosen because it "can never
 * tie" where generated_at can, but on the self-host Postgres backend pg-dialect's translateRowid rewrites every
 * `rowid` to `ctid`, which is a PHYSICAL heap location, not insertion order: once the age-prune frees pages, a
 * NEWER row inserted into a reclaimed early page gets a LOWER ctid than an older row on a later page, so
 * MAX(ctid) selected a STALE row and this delete removed the genuinely newest snapshot. Confirmed on production
 * (2026-07-27): ~36% of multi-row keys for contributor-evidence-graph had ctid order disagreeing with recency.
 * translateRowid's own doc says it is only safe for bookkeeping resolved WITHIN one statement and "never for
 * durable application-facing row identity" -- deciding which row survives a DELETE is exactly that. The id
 * tiebreak restores the total ordering rowid was providing, without depending on physical layout.
 */
export async function dedupeSignalSnapshots(
  env: Env,
  options: { dryRun?: boolean; batchSize?: number; maxPerType?: number } = {},
): Promise<SignalSnapshotDedupeResult[]> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPerType = options.maxPerType ?? MAX_DELETED_PER_TABLE;
  const results: SignalSnapshotDedupeResult[] = [];

  const placeholders = LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES.map((_, index) => `?${index + 1}`).join(", ");
  const types = await env.DB.prepare(`SELECT DISTINCT signal_type FROM signal_snapshots WHERE signal_type IN (${placeholders})`)
    .bind(...LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES)
    .all<{ signal_type: string }>();

  for (const { signal_type: signalType } of types.results) {
    // One index-backed lookup per distinct target_key (signal_snapshots_target_idx covers
    // (signal_type, target_key, generated_at)), rather than a table-wide window function -- same
    // per-statement-budget discipline as the batching above.
    const staleCondition = `signal_type = ?1 AND id NOT IN (SELECT (SELECT newest.id FROM signal_snapshots AS newest WHERE newest.signal_type = ?1 AND newest.target_key = keys.target_key ORDER BY newest.generated_at DESC, newest.id DESC LIMIT 1) FROM (SELECT DISTINCT target_key FROM signal_snapshots WHERE signal_type = ?1) AS keys)`;

    if (dryRun) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM signal_snapshots WHERE ${staleCondition}`).bind(signalType).first<{ n: number }>();
      results.push({ signalType, deleted: Number(row?.n ?? 0) });
      continue;
    }

    let deleted = 0;
    for (;;) {
      // Batch by the real primary key, not rowid -- see the #9470 note above: on Postgres `rowid` becomes
      // `ctid`, so the outer `IN` degrades to a full seq scan AND carries the same physical-location semantics.
      const result = await env.DB.prepare(`DELETE FROM signal_snapshots WHERE id IN (SELECT id FROM signal_snapshots WHERE ${staleCondition} LIMIT ${batchSize})`)
        .bind(signalType)
        .run();
      const changes = Number(result.meta?.changes ?? 0);
      deleted += changes;
      if (changes < batchSize || deleted >= maxPerType) break;
    }
    results.push({ signalType, deleted });
  }

  return results;
}
