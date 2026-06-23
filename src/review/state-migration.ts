import { nowIso } from "../utils/json";

type TableCheck = {
  name: string;
  requiredColumns: string[];
};

type OpenPullRequestRow = {
  repo_full_name: string;
  number: number;
  head_sha: string | null;
};

type ReviewTargetRow = {
  repo: string | null;
  number: number | null;
  kind: string | null;
  status: string | null;
  head_sha: string | null;
  decided_sha: string | null;
  approved_sha: string | null;
};

export interface StateMigrationTableStatus {
  name: string;
  exists: boolean;
  rowCount: number | null;
  requiredColumns: string[];
  missingColumns: string[];
}

export interface StateMigrationStormGuardRow {
  repoFullName: string;
  pullNumber: number;
  headSha: string | null;
}

export interface StateMigrationReadinessReport {
  generatedAt: string;
  dryRun: true;
  cutoverRepos: string[];
  tables: StateMigrationTableStatus[];
  counts: {
    openPullRequests: number;
    reviewTargets: number;
    reviewAuditRows: number;
    reviewAuditComparableRows: number;
    submitterStats: number;
    tunablesOverrides: number;
    tunablesOverridesShadow: number;
    overrideAuditRows: number;
  };
  stormGuard: {
    matchedTargets: number;
    cachedHeadMatches: number;
    approvedShaMatches: number;
    missingTargetRows: StateMigrationStormGuardRow[];
    missingDecisionCacheRows: StateMigrationStormGuardRow[];
    missingApprovedShaRows: StateMigrationStormGuardRow[];
    massReenqueueRisk: boolean;
    summary: string;
  };
  blockers: string[];
  ready: boolean;
}

const REQUIRED_TABLES: TableCheck[] = [
  { name: "review_targets", requiredColumns: ["project", "kind", "repo", "number", "head_sha", "decided_sha", "approved_sha", "decision_json"] },
  { name: "submitter_stats", requiredColumns: ["project", "submitter", "submissions", "merged", "closed", "manual", "last_seen"] },
  { name: "tunables_overrides", requiredColumns: ["project", "confidence_floor", "scope_cap_files", "scope_cap_lines", "applied_at", "clear_at"] },
  { name: "tunables_overrides_shadow", requiredColumns: ["project", "confidence_floor", "scope_cap_files", "scope_cap_lines", "applied_at", "validated_until", "clear_at"] },
  { name: "override_audit", requiredColumns: ["project", "event_type", "detail", "created_at"] },
  { name: "review_audit", requiredColumns: ["project", "target_id", "event_type", "decision", "source", "head_sha", "summary", "created_at"] },
];

function parseCutoverRepos(env: { GITTENSORY_REVIEW_REPOS?: string | undefined }): string[] {
  return [...new Set((env.GITTENSORY_REVIEW_REPOS ?? "").split(",").map((repo) => repo.trim().toLowerCase()).filter(Boolean))];
}

async function rawFirst<T extends Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
}

async function rawAll<T extends Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...binds).all<T>();
  return result.results;
}

async function tableStatus(env: Env, table: TableCheck): Promise<StateMigrationTableStatus> {
  const exists = Boolean(await rawFirst<{ name: string }>(env, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table.name));
  if (!exists) return { name: table.name, exists: false, rowCount: null, requiredColumns: table.requiredColumns, missingColumns: [...table.requiredColumns] };
  const columns = await rawAll<{ name: string }>(env, `PRAGMA table_info(${table.name})`);
  const have = new Set(columns.map((column) => String(column.name).toLowerCase()));
  const missingColumns = table.requiredColumns.filter((column) => !have.has(column.toLowerCase()));
  const rowCount = Number((await rawFirst<{ n: number }>(env, `SELECT COUNT(*) AS n FROM ${table.name}`))?.n ?? 0);
  return { name: table.name, exists: true, rowCount, requiredColumns: table.requiredColumns, missingColumns };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function computeStateMigrationReadiness(env: Env): Promise<StateMigrationReadinessReport> {
  const cutoverRepos = parseCutoverRepos(env);
  const tables = await Promise.all(REQUIRED_TABLES.map((table) => tableStatus(env, table)));
  const blockers = tables.flatMap((table) => (!table.exists ? [`Missing state-migration table: ${table.name}.`] : table.missingColumns.map((column) => `${table.name} is missing required column ${column}.`)));

  const reviewTargets = tables.find((table) => table.name === "review_targets")?.rowCount ?? 0;
  const reviewAuditRows = tables.find((table) => table.name === "review_audit")?.rowCount ?? 0;
  const submitterStats = tables.find((table) => table.name === "submitter_stats")?.rowCount ?? 0;
  const tunablesOverrides = tables.find((table) => table.name === "tunables_overrides")?.rowCount ?? 0;
  const tunablesOverridesShadow = tables.find((table) => table.name === "tunables_overrides_shadow")?.rowCount ?? 0;
  const overrideAuditRows = tables.find((table) => table.name === "override_audit")?.rowCount ?? 0;

  let openPullRequests: OpenPullRequestRow[] = [];
  let targetRows: ReviewTargetRow[] = [];
  let reviewAuditComparableRows = 0;

  if (cutoverRepos.length > 0) {
    const binds = cutoverRepos.map((repo) => repo.toLowerCase());
    openPullRequests = await rawAll<OpenPullRequestRow>(
      env,
      `SELECT repo_full_name, number, head_sha
       FROM pull_requests
       WHERE state = 'open' AND lower(repo_full_name) IN (${placeholders(binds.length)})`,
      ...binds,
    );
    targetRows = await rawAll<ReviewTargetRow>(
      env,
      `SELECT repo, number, kind, status, head_sha, decided_sha, approved_sha
       FROM review_targets
       WHERE lower(repo) IN (${placeholders(binds.length)}) AND lower(kind) IN ('pr', 'pull_request')`,
      ...binds,
    );
    reviewAuditComparableRows = Number(
      (
        await rawFirst<{ n: number }>(
          env,
          `SELECT COUNT(*) AS n
           FROM review_audit
           WHERE lower(project) IN (${placeholders(binds.length)}) AND event_type = 'gate_decision' AND source IS NOT NULL AND head_sha IS NOT NULL`,
          ...binds,
        )
      )?.n ?? 0,
    );
  }

  const targetByRepoAndNumber = new Map<string, ReviewTargetRow>();
  for (const row of targetRows) {
    if (!row.repo || row.number === null) continue;
    targetByRepoAndNumber.set(`${row.repo.toLowerCase()}#${row.number}`, row);
  }

  const missingTargetRows: StateMigrationStormGuardRow[] = [];
  const missingDecisionCacheRows: StateMigrationStormGuardRow[] = [];
  const missingApprovedShaRows: StateMigrationStormGuardRow[] = [];

  for (const pr of openPullRequests) {
    const row = targetByRepoAndNumber.get(`${pr.repo_full_name.toLowerCase()}#${pr.number}`);
    const view = { repoFullName: pr.repo_full_name, pullNumber: pr.number, headSha: pr.head_sha };
    if (!row) {
      missingTargetRows.push(view);
      missingDecisionCacheRows.push(view);
      continue;
    }
    const prHead = (pr.head_sha ?? "").toLowerCase();
    const decided = (row.decided_sha ?? "").toLowerCase();
    const approved = (row.approved_sha ?? "").toLowerCase();
    if (!prHead || !decided || decided !== prHead) missingDecisionCacheRows.push(view);
    if (!prHead || !approved || approved !== prHead) missingApprovedShaRows.push(view);
  }

  if (cutoverRepos.length > 0 && submitterStats === 0) blockers.push("submitter_stats is empty for a cutover run; reputation reset risk remains.");
  if (cutoverRepos.length > 0 && reviewAuditComparableRows === 0) blockers.push("review_audit has no comparable source/head_sha rows for the cutover repos; parity history is missing.");
  if (cutoverRepos.length > 0 && tunablesOverrides === 0 && tunablesOverridesShadow === 0 && overrideAuditRows === 0) {
    blockers.push("Tunables override tables and override audit are all empty; self-improve state did not migrate.");
  }
  if (missingTargetRows.length > 0) blockers.push(`${missingTargetRows.length} open PR(s) on cutover repos have no review_targets row.`);
  if (missingDecisionCacheRows.length > 0) blockers.push(`${missingDecisionCacheRows.length} open PR(s) on cutover repos are missing a matching decided_sha decision cache.`);

  const matchedTargets = openPullRequests.length - missingTargetRows.length;
  const cachedHeadMatches = openPullRequests.length - missingDecisionCacheRows.length;
  const approvedShaMatches = openPullRequests.length - missingApprovedShaRows.length;
  const massReenqueueRisk = missingTargetRows.length > 0 || missingDecisionCacheRows.length > 0;

  return {
    generatedAt: nowIso(),
    dryRun: true,
    cutoverRepos,
    tables,
    counts: {
      openPullRequests: openPullRequests.length,
      reviewTargets,
      reviewAuditRows,
      reviewAuditComparableRows,
      submitterStats,
      tunablesOverrides,
      tunablesOverridesShadow,
      overrideAuditRows,
    },
    stormGuard: {
      matchedTargets,
      cachedHeadMatches,
      approvedShaMatches,
      missingTargetRows,
      missingDecisionCacheRows,
      missingApprovedShaRows,
      massReenqueueRisk,
      summary:
        cutoverRepos.length === 0
          ? "No cutover repos are allowlisted; the dry-run found no active cutover surface to verify."
          : massReenqueueRisk
            ? `Storm risk detected: ${missingDecisionCacheRows.length} open PR(s) would lose their per-head decision cache after cutover.`
            : `No mass re-enqueue risk detected across ${openPullRequests.length} open PR(s) on the cutover repos.`,
    },
    blockers,
    ready: blockers.length === 0,
  };
}
