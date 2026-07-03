import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type DashboardTarget = {
  expr?: string;
  legendFormat?: string;
  queryText?: string;
  rawQueryText?: string;
};

type DashboardPanel = {
  id?: number;
  title?: string;
  targets?: DashboardTarget[];
};

type Dashboard = {
  panels: DashboardPanel[];
};

const tmpRoots: string[] = [];
const dashboardPath = join(process.cwd(), "grafana/dashboards/maintainer-reviews.json");
const selfhostDashboardPath = join(process.cwd(), "grafana/dashboards/gittensory.json");
const selfhostAlertsPath = join(process.cwd(), "prometheus/rules/alerts.yml");
const timeFrom = "${__from:date:seconds}";
const timeTo = "${__to:date:seconds}";

const sqliteCliAvailable = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function readDashboard(path = dashboardPath): Dashboard {
  return JSON.parse(readFileSync(path, "utf8")) as Dashboard;
}

function reviewTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .filter((target) => target.queryText?.includes("review_targets"));
}

function targetForPanel(panelId: number): DashboardTarget {
  const panel = readDashboard().panels.find((candidate) => candidate.id === panelId);
  const target = panel?.targets?.[0];
  if (!target?.queryText) throw new Error(`missing query target for panel ${panelId}`);
  return target;
}

function expandGrafanaRange(query: string): string {
  const from = Math.floor(Date.parse("2026-06-29T20:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-06-29T22:00:00Z") / 1000);
  return query.replaceAll(timeFrom, String(from)).replaceAll(timeTo, String(to));
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-grafana-dashboard-"));
  tmpRoots.push(dir);
  return dir;
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Gittensory Self-Host Grafana dashboard", () => {
  it("surfaces the GitHub response cache Prometheus counters", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);

    expect(targets.some((target) => target.expr === "sum by (result) (rate(gittensory_github_response_cache_total[5m]))")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (class, result) (gittensory_github_response_cache_total)")).toBe(true);
    expect(targets.some((target) => target.legendFormat === "{{class}} {{result}}")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (remaining_bucket, key_scope) (rate(gittensory_github_rest_rate_limit_observations_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (status, retry, key_scope) (rate(gittensory_github_rest_rate_limit_responses_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (kind, key_scope, job_type) (rate(gittensory_jobs_rate_limit_admission_deferred_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (kind, key_scope, job_type) (rate(gittensory_jobs_rate_limit_budget_deferred_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (kind, key_scope, job_type) (rate(gittensory_jobs_rate_limited_by_type_total[5m])) or vector(0)")).toBe(true);
  });

  it("keeps Orb dashboard panels zero-safe when telemetry counters are absent", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);

    expect(targets.some((target) => target.expr === "gittensory_orb_events_recorded_total or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_orb_events_exported_total or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_orb_installs_total or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (result) (rate(gittensory_orb_webhook_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "(gittensory_orb_events_recorded_total or vector(0)) - (gittensory_orb_events_exported_total or vector(0))")).toBe(true);
  });

  it("keeps rate-limit alerts grouped by the dashboard label dimensions", () => {
    const alerts = readFileSync(selfhostAlertsPath, "utf8");

    expect(alerts).toContain("sum by (status, retry, key_scope) (rate(gittensory_github_rest_rate_limit_responses_total[5m])) > 0");
    expect(alerts).toContain("sum by (kind, key_scope, job_type) (rate(gittensory_jobs_rate_limit_admission_deferred_total[5m])) > 0.05");
    expect(alerts).toContain("sum by (kind, key_scope, job_type) (rate(gittensory_jobs_rate_limit_budget_deferred_total[5m])) > 0.05");
  });

  it("surfaces Postgres internals and backup freshness panels", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const titles = dashboard.panels.map((panel) => panel.title);

    expect(titles).toEqual(expect.arrayContaining(["Postgres & Backups", "Postgres Connections by State", "Postgres Locks & Slow Transactions", "Postgres Size & Table Growth", "Dead Tuples / Autovacuum", "Backup Freshness"]));
    expect(targets.some((target) => target.expr === 'pg_up or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum(pg_stat_activity_count{datname="gittensory"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum by (state) (pg_stat_activity_count{datname="gittensory"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum(pg_stat_activity_count{datname="gittensory", wait_event_type="Lock"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'max(pg_stat_activity_max_tx_duration{datname="gittensory"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'pg_database_size_bytes{datname="gittensory"} or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'topk(10, pg_stat_user_tables_n_live_tup{datname="gittensory"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'topk(10, pg_stat_user_tables_n_dead_tup{datname="gittensory"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum by (relname) (increase(pg_stat_user_tables_autovacuum_count{datname="gittensory"}[1h])) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'gittensory_backup_files{target=~"postgres|sqlite|qdrant"} or vector(0)')).toBe(true);
  });

  it("ships Postgres and backup alerts for the same dashboarded failure modes", () => {
    const alerts = readFileSync(selfhostAlertsPath, "utf8");

    expect(alerts).toContain("alert: GittensoryPostgresConnectionPressure");
    expect(alerts).toContain('sum(pg_stat_activity_count{datname="gittensory"})');
    expect(alerts).toContain("alert: GittensoryPostgresLockWaits");
    expect(alerts).toContain('pg_stat_activity_count{datname="gittensory", wait_event_type="Lock"}');
    expect(alerts).toContain("alert: GittensoryPostgresSlowTransaction");
    expect(alerts).toContain('pg_stat_activity_max_tx_duration{datname="gittensory"}');
    expect(alerts).toContain("alert: GittensoryPostgresDeadlocks");
    expect(alerts).toContain('pg_stat_database_deadlocks{datname="gittensory"}');
    expect(alerts).toContain("alert: GittensoryPostgresDatabaseGrowingFast");
    expect(alerts).toContain('deriv(pg_database_size_bytes{datname="gittensory"}[6h]) > 262144');
    expect(alerts).toContain("alert: GittensoryPostgresDeadTuplesHigh");
    expect(alerts).toContain('pg_stat_user_tables_n_dead_tup{datname="gittensory"}');
    expect(alerts).toContain("alert: GittensoryBackupMissing");
    expect(alerts).toContain('gittensory_backup_files{target=~"postgres|sqlite"} == 0');
    expect(alerts).toContain("alert: GittensoryBackupStale");
    expect(alerts).toContain('time() - gittensory_backup_latest_timestamp_seconds{target=~"postgres|sqlite"} > 93600');
  });

  it("surfaces self-host runtime-drift signal panels, every counter query fleet-aggregated", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const titles = dashboard.panels.map((panel) => panel.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        "Self-Host Runtime Drift Signals",
        "Maintenance Trickle-Admitted (stuck under sustained pressure)",
        "Orb Relay Registration Failures (total)",
        "Installation Health: Broker Probe Failures (total)",
        "Agent Permission-Denied Actions (total)",
        "Agent Permission-Denied Actions by Class (denied vs suppressed-repeat rate)",
        "Orb Relay Registration Attempts by Mode/Result (rate)",
      ]),
    );
    // Every stat-panel counter is sum()-wrapped, matching its siblings -- a multi-instance self-host scrape
    // must render one fleet-level value per stat, not one value per target (gate finding, #chore-runtime-drift).
    expect(targets.some((target) => target.expr === "sum(gittensory_jobs_maintenance_trickle_admitted_persisted_total) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === 'sum(gittensory_orb_relay_register_total{result="failed"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum(gittensory_installation_health_broker_probe_total{result="failed"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === "sum(gittensory_agent_action_permission_denied_total) or vector(0)")).toBe(true);
    // Grouped (sum-by) queries must NOT have "or vector(0)": Prometheus's `or` unions result sets, and
    // vector(0) is a single unlabeled series that can't match the actionClass/mode,result label set --
    // that renders a bogus extra unlabeled zero-series alongside the real labeled series (gate finding).
    expect(targets.some((target) => target.expr === "sum by (actionClass) (rate(gittensory_agent_action_permission_denied_total[5m]))")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (actionClass) (rate(gittensory_agent_action_permission_denied_suppressed_total[5m]))")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (mode, result) (rate(gittensory_orb_relay_register_total[5m]))")).toBe(true);
  });
});

describe("maintainer Reviews & PRs Grafana dashboard", () => {
  it("binds every review_targets panel query to Grafana's selected time range", () => {
    const targets = reviewTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.rawQueryText).toBe(target.queryText);
      expect(target.queryText).toContain("unixepoch(updated_at)");
      expect(target.queryText).toContain(timeFrom);
      expect(target.queryText).toContain(timeTo);
    }
  });

  (sqliteCliAvailable ? it : it.skip)("filters the pull request table to the selected time window", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(db, `
      CREATE TABLE review_targets (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        submitter TEXT,
        status TEXT NOT NULL,
        verdict TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO review_targets (repo, number, submitter, status, verdict, title, created_at, updated_at)
      VALUES
        ('owner/repo', 1, 'old', 'commented', 'comment', 'old row', '2026-06-29T18:00:00Z', '2026-06-29T18:30:00Z'),
        ('owner/repo', 2, 'new', 'commented', 'comment', 'new row', '2026-06-29T20:30:00Z', '2026-06-29T21:00:00Z');
    `);

    const tableQuery = expandGrafanaRange(targetForPanel(8).queryText!);
    const rows = sqlite(db, tableQuery);

    expect(rows).toContain("owner/repo|2|new|commented|comment|new row|2026-06-29T21:00:00Z");
    expect(rows).not.toContain("old row");
  });
});
