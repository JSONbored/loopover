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
  format?: string;
  instant?: boolean;
  queryType?: string;
  options?: { query?: string; timeField?: number };
};

type DashboardPanel = {
  id?: number;
  title?: string;
  description?: string;
  targets?: DashboardTarget[];
  datasource?: { type?: string; uid?: string };
};

type Dashboard = {
  panels: DashboardPanel[];
};

const tmpRoots: string[] = [];
const dashboardPath = join(process.cwd(), "grafana/dashboards/maintainer-reviews.json");
const selfhostDashboardPath = join(process.cwd(), "grafana/dashboards/gittensory.json");
const selfhostAlertsPath = join(process.cwd(), "prometheus/rules/alerts.yml");
const githubPrsPath = join(process.cwd(), "grafana/dashboards/github-prs.json");
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

function grafanaSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function expandGrafanaRange(query: string, repo = "$__all"): string {
  const from = Math.floor(Date.parse("2026-06-29T20:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-06-29T22:00:00Z") / 1000);
  // Every panel's repo variable also needs expanding for a real sqlite3 CLI run, same as the time
  // placeholders above -- Grafana's own templating engine does this substitution normally, so a raw
  // file-read + direct sqlite3 execution (what these tests do) has to simulate its SQL string format.
  return query.replaceAll(timeFrom, String(from)).replaceAll(timeTo, String(to)).replaceAll("${repo:sqlstring}", grafanaSqlString(repo));
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
    // The AI request/fallback + cost/token panels moved to the consolidated grafana/dashboards/ai-usage.json
    // (Phase B2, 2026-07) — see test/unit/selfhost-grafana-ai-usage-dashboard.test.ts for their coverage there.
  });

  it("no longer duplicates the AI cost/token panels moved to the consolidated ai-usage.json dashboard (Phase B2, 2026-07 fix)", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const titles = dashboard.panels.map((panel) => panel.title);
    const ids = dashboard.panels.map((panel) => panel.id);

    expect(titles).not.toContain("AI Usage & Cost (per provider)");
    expect(titles).not.toContain("Tokens/min by provider");
    expect(titles).not.toContain("AI requests + fallbacks (last 1h)");
    expect(titles).not.toContain("Cumulative AI cost (USD) by provider");
    expect(titles).not.toContain("Total tokens by provider + kind");
    expect(ids).not.toEqual(expect.arrayContaining([108, 109, 110, 111, 112]));
  });

  it("keeps Orb dashboard panels zero-safe when telemetry counters are absent", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);

    expect(targets.some((target) => target.expr === "gittensory_orb_events_exported_total or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_orb_export_errors_total or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (result) (rate(gittensory_orb_webhook_total[5m])) or vector(0)")).toBe(true);
  });

  it("no longer references gittensory_orb_events_recorded_total / gittensory_orb_installs_total, retired with the per-instance Orb App in #1256 but never cleaned out of the dashboard (2026-07 fix)", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const titles = dashboard.panels.map((panel) => panel.title);

    for (const target of targets) {
      expect(target.expr ?? "").not.toContain("gittensory_orb_events_recorded_total");
      expect(target.expr ?? "").not.toContain("gittensory_orb_installs_total");
    }
    expect(titles).not.toContain("Orb Events Recorded");
    expect(titles).not.toContain("Orb Installations");
    expect(titles).not.toContain("Orb Pending vs Exported");
  });

  it("assigns every panel a unique id (regression: 'Maintenance Admission Deferrals (total)' and 'Orb Relay Registration: Streak vs Drain Progress' both used id 158, 2026-07 fix)", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const ids = dashboard.panels.map((panel) => panel.id).filter((id): id is number => id !== undefined);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect(duplicates).toEqual([]);
  });

  it("surfaces the onMerge/combine/reviewer-count floor-clamp counter on a panel and an alert (#3901)", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const alerts = readFileSync(selfhostAlertsPath, "utf8");

    expect(targets.some((target) => target.expr === "gittensory_ai_review_onmerge_clamped_total or vector(0)")).toBe(true);
    expect(alerts).toContain("alert: GittensoryAiReviewOnMergeFloorBypassAttempted");
    expect(alerts).toContain("expr: increase(gittensory_ai_review_onmerge_clamped_total[1h]) > 0");
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
    expect(targets.some((target) => target.expr === 'sum(pg_stat_activity_count{datname="loopover"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum by (state) (pg_stat_activity_count{datname="loopover"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum(pg_stat_activity_count{datname="loopover", wait_event_type="Lock"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'max(pg_stat_activity_max_tx_duration{datname="loopover"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'pg_database_size_bytes{datname="loopover"} or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'topk(10, pg_stat_user_tables_n_live_tup{datname="loopover"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'topk(10, pg_stat_user_tables_n_dead_tup{datname="loopover"}) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'sum by (relname) (increase(pg_stat_user_tables_autovacuum_count{datname="loopover"}[1h])) or vector(0)')).toBe(true);
    expect(targets.some((target) => target.expr === 'gittensory_backup_files{target=~"postgres|sqlite|qdrant"} or vector(0)')).toBe(true);
  });

  it("ships Postgres and backup alerts for the same dashboarded failure modes", () => {
    const alerts = readFileSync(selfhostAlertsPath, "utf8");

    expect(alerts).toContain("alert: GittensoryPostgresConnectionPressure");
    expect(alerts).toContain('sum(pg_stat_activity_count{datname="loopover"})');
    expect(alerts).toContain("alert: GittensoryPostgresLockWaits");
    expect(alerts).toContain('pg_stat_activity_count{datname="loopover", wait_event_type="Lock"}');
    expect(alerts).toContain("alert: GittensoryPostgresSlowTransaction");
    expect(alerts).toContain('pg_stat_activity_max_tx_duration{datname="loopover"}');
    expect(alerts).toContain("alert: GittensoryPostgresDeadlocks");
    expect(alerts).toContain('pg_stat_database_deadlocks{datname="loopover"}');
    expect(alerts).toContain("alert: GittensoryPostgresDatabaseGrowingFast");
    expect(alerts).toContain('deriv(pg_database_size_bytes{datname="loopover"}[6h]) > 262144');
    expect(alerts).toContain("alert: GittensoryPostgresDeadTuplesHigh");
    expect(alerts).toContain('pg_stat_user_tables_n_dead_tup{datname="loopover"}');
    expect(alerts).toContain("alert: GittensoryBackupMissing");
    expect(alerts).toContain('gittensory_backup_files{target=~"postgres|sqlite"} == 0');
    expect(alerts).toContain("alert: GittensoryBackupStale");
    expect(alerts).toContain('time() - gittensory_backup_latest_timestamp_seconds{target=~"postgres|sqlite"} > 93600');
  });

  it("surfaces a Maintenance Admission Deferrals (total) panel alongside the by-reason breakdown", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const titles = dashboard.panels.map((panel) => panel.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        "Runtime Pressure & Maintenance",
        "Maintenance Admission Deferrals by Reason",
        "Maintenance Admission Deferrals (total)",
      ]),
    );
    expect(targets.some((target) => target.expr === "sum by (reason, job_type) (rate(gittensory_jobs_maintenance_admission_deferred_by_reason_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "sum(rate(gittensory_jobs_maintenance_admission_deferred_total[5m])) or vector(0)")).toBe(true);
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
        "Orb Relay Registration: Streak vs Drain Progress (one hiccup vs actually stuck)",
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
    // #selfhost-runtime-drift follow-up: the streak-vs-drain-progress panel is the dashboard-visible
    // counterpart to isOrbRelayRegistrationAlerting's gate -- a lone registration timeout must not read as
    // a dashboard error on its own as long as the drain loop is still making progress.
    expect(targets.some((target) => target.expr === "gittensory_orb_relay_register_consecutive_failures or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_orb_relay_drain_seconds_since_last or vector(0)")).toBe(true);

    const alerts = readFileSync(selfhostAlertsPath, "utf8");
    expect(alerts).toContain("alert: GittensoryOrbRelayRegistrationStuck");
    expect(alerts).toContain("gittensory_orb_relay_register_consecutive_failures >= 3 or gittensory_orb_relay_drain_seconds_since_last > 1800");
  });

  it("surfaces the backlog-vs-fresh-intake lane fairness panels (#selfhost-lane-observability)", () => {
    const dashboard = readDashboard(selfhostDashboardPath);
    const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
    const titles = dashboard.panels.map((panel) => panel.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        "Backlog-vs-Fresh-Intake Lane Fairness (#selfhost-lane-observability)",
        "Backlog-Convergence Pending",
        "Fresh-Intake Pending",
        "GitHub REST Rate Limit Remaining (by scope)",
        "Foreground Claims by Lane (rate)",
        "Top Repos by Backlog Depth",
      ]),
    );
    expect(targets.some((target) => target.expr === "gittensory_queue_backlog_convergence_pending")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_queue_fresh_intake_pending")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_github_rest_rate_limit_remaining")).toBe(true);
    expect(targets.some((target) => target.legendFormat === "{{key_scope}}" && target.expr === "gittensory_github_rest_rate_limit_remaining")).toBe(true);
    expect(targets.some((target) => target.expr === "sum by (lane) (rate(gittensory_jobs_claimed_by_lane_total[5m])) or vector(0)")).toBe(true);
    expect(targets.some((target) => target.expr === "gittensory_queue_backlog_by_repo" && target.format === "table" && target.instant === true)).toBe(true);
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

  it("explains the latest-update-in-window (not lifetime) semantics on Manual/Approved/Ignored (#3717)", () => {
    const dashboard = readDashboard();
    const panelsById = new Map(dashboard.panels.map((panel) => [panel.id, panel]));

    for (const [id, title] of [
      [5, "Manual review"],
      [6, "Approved (pending merge)"],
      [7, "Ignored (no gate decision yet)"],
    ] as const) {
      const panel = panelsById.get(id);
      expect(panel?.title).toBe(title);
      expect(panel?.description?.length ?? 0).toBeGreaterThan(0);
      expect(panel?.description).toContain("window");
    }
  });

  it("redefines 'Ignored' around verdict IS NULL, not the dead status='ignored'/verdict='ignore' values (2026-07 fix)", () => {
    const target = targetForPanel(7);

    expect(target.queryText).toContain("status='manual'");
    expect(target.queryText).toContain("verdict IS NULL");
    expect(target.queryText).not.toContain("status='ignored'");
    expect(target.queryText).not.toContain("verdict='ignore'");
  });

  it("adds local, webhook-observed issue-activity stat panels alongside the review_targets PR panels (#3716, switched off the GitHub API 2026-07)", () => {
    const dashboard = readDashboard();
    const panelsById = new Map(dashboard.panels.map((panel) => [panel.id, panel]));

    for (const [id, title] of [
      [12, "Issues opened"],
      [13, "Issues closed"],
      [14, "Issues open"],
    ] as const) {
      const panel = panelsById.get(id);
      expect(panel?.title).toBe(title);
      expect(panel?.datasource?.type).toBe("frser-sqlite-datasource");
      const target = panel?.targets?.[0];
      expect(target?.queryType).toBe("table");
      expect(target?.rawQueryText).toBe(target?.queryText);
      expect(target?.queryText).toContain("FROM issues");
      expect(target?.queryText).toContain("(${repo:sqlstring} = '$__all' OR repo = ${repo:sqlstring})");
      expect(panel?.description?.length ?? 0).toBeGreaterThan(0);
    }

    // "Issues opened"/"Issues closed" are flow counts bound to the dashboard's selected time window, same as
    // every review_targets panel above; "Issues open" is deliberately a current-state snapshot with no time
    // filter at all (mirrors github-prs.json's own "Open issues" panel semantics).
    expect(targetForPanel(12).queryText).toContain("unixepoch(created_at)");
    expect(targetForPanel(12).queryText).toContain(timeFrom);
    expect(targetForPanel(13).queryText).toContain("state='closed'");
    expect(targetForPanel(13).queryText).toContain("unixepoch(updated_at)");
    expect(targetForPanel(13).queryText).toContain(timeTo);
    expect(targetForPanel(14).queryText).toContain("state='open'");
    expect(targetForPanel(14).queryText).not.toContain("unixepoch");
  });

  it("scopes the issue-activity panels to the selected $repo, same as the PR panels", () => {
    for (const id of [12, 13, 14] as const) {
      expect(targetForPanel(id).queryText).toContain("(${repo:sqlstring} = '$__all' OR repo = ${repo:sqlstring})");
    }
  });

  it("declares a dynamic, query-backed $repo template variable (not a hardcoded repo list)", () => {
    const dashboard = readDashboard() as unknown as {
      templating: { list: Array<{ name: string; type: string; datasource?: { type?: string }; query?: { rawQueryText?: string }; includeAll?: boolean }> };
    };
    const vars = dashboard.templating.list;

    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("repo");
    expect(vars[0]!.type).toBe("query");
    expect(vars[0]!.includeAll).toBe(true);
    expect(vars[0]!.datasource?.type).toBe("frser-sqlite-datasource");
    expect(vars[0]!.query?.rawQueryText).toBe("SELECT DISTINCT repo FROM review_targets ORDER BY repo");
  });

  it("scopes every review_targets panel query to the selected repo with Grafana SQL-string escaping", () => {
    const targets = reviewTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.queryText).toContain("(${repo:sqlstring} = '$__all' OR repo = ${repo:sqlstring})");
      expect(target.queryText).not.toContain("'$repo'");
    }
  });

  (sqliteCliAvailable ? it : it.skip)("issue-activity panels count real rows correctly by state and window", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(db, `
      CREATE TABLE issues (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        author TEXT,
        state TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO issues (repo, number, author, state, title, created_at, updated_at)
      VALUES
        ('owner/repo', 1, 'alice', 'open', 'opened in window', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z'),
        ('owner/repo', 2, 'bob', 'closed', 'closed in window', '2026-06-01T00:00:00Z', '2026-06-29T21:00:00Z'),
        ('owner/repo', 3, 'carol', 'open', 'opened before window', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
        ('other/repo', 4, 'dave', 'open', 'different repo', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z');
    `);

    const opened = sqlite(db, expandGrafanaRange(targetForPanel(12).queryText!));
    const closed = sqlite(db, expandGrafanaRange(targetForPanel(13).queryText!));
    const open = sqlite(db, expandGrafanaRange(targetForPanel(14).queryText!));

    // Issues #1 (owner/repo) and #4 (other/repo) were both created inside the window -- "All repos" is
    // selected here (expandGrafanaRange's default), so the different-repo row still counts.
    expect(opened).toBe("2");
    // Only issue #2 is closed with an updated_at inside the window.
    expect(closed).toBe("1");
    // Open is a state snapshot across all repos/time: issues #1, #3, #4 are open.
    expect(open).toBe("3");
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

  (sqliteCliAvailable ? it : it.skip)("actually narrows the PRs-tracked count to a selected $repo, and 'All' still includes every repo", () => {
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
        ('owner/repo-a', 1, 'alice', 'merged', 'merge', 'in repo a', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z'),
        ('owner/repo-b', 2, 'bob', 'merged', 'merge', 'in repo b', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z'),
        ('owner/repo-b', 3, 'carol', 'merged', 'merge', 'also in repo b', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z');
    `);

    const trackedQuery = targetForPanel(2).queryText!;
    const allRepos = sqlite(db, expandGrafanaRange(trackedQuery));
    // A specific repo selection substitutes BOTH repo occurrences with the same SQL-escaped repo value (never
    // the literal "$__all" sentinel, which only appears when "All" is selected).
    const repoAOnly = sqlite(db, expandGrafanaRange(trackedQuery, "owner/repo-a"));
    const repoBOnly = sqlite(db, expandGrafanaRange(trackedQuery, "owner/repo-b"));

    expect(allRepos).toBe("3");
    expect(repoAOnly).toBe("1");
    expect(repoBOnly).toBe("2");
  });


  (sqliteCliAvailable ? it : it.skip)("SQL-escapes repo variable values instead of interpolating raw dashboard input", () => {
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
        ('owner/repo-a', 1, 'alice', 'merged', 'merge', 'in repo a', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z'),
        ('owner/repo-b', 2, 'bob', 'merged', 'merge', 'in repo b', '2026-06-29T20:30:00Z', '2026-06-29T20:30:00Z');
    `);

    const trackedQuery = targetForPanel(2).queryText!;
    const injectedRepo = "x') OR 1=1 --";

    expect(sqlite(db, expandGrafanaRange(trackedQuery, injectedRepo))).toBe("0");
  });

  it("excludes bot-authored PRs from every review_targets panel query, not just the table", () => {
    const targets = reviewTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.queryText).toContain("submitter NOT LIKE '%[bot]%'");
    }
  });

  (sqliteCliAvailable ? it : it.skip)("drops a bot-authored release PR from the tracked-PR count and table (#4685-follow-up)", () => {
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
        ('owner/repo', 1, 'github-actions[bot]', 'merged', 'merge', 'chore(release): cut v1.0.0', '2026-06-29T20:00:00Z', '2026-06-29T20:30:00Z'),
        ('owner/repo', 2, 'a-human', 'merged', 'merge', 'a real contribution', '2026-06-29T20:00:00Z', '2026-06-29T21:00:00Z'),
        ('owner/repo', 3, NULL, 'merged', 'merge', 'legacy row, no submitter recorded', '2026-06-29T20:00:00Z', '2026-06-29T21:15:00Z');
    `);

    const trackedCount = sqlite(db, expandGrafanaRange(targetForPanel(2).queryText!));
    const mergedCount = sqlite(db, expandGrafanaRange(targetForPanel(3).queryText!));
    const tableRows = sqlite(db, expandGrafanaRange(targetForPanel(8).queryText!));

    // The bot's own release-automation PR must not inflate either the tracked or the merged tile, but a
    // NULL submitter (a legacy pre-migration row that never recorded one) is not a bot and must still count.
    expect(trackedCount).toBe("2");
    expect(mergedCount).toBe("2");
    expect(tableRows).toContain("a real contribution");
    expect(tableRows).toContain("legacy row, no submitter recorded");
    expect(tableRows).not.toContain("cut v1.0.0");
  });
});

describe("github-prs.json: $scope is dynamic, never a hardcoded repo list (2026-07 fix)", () => {
  function readGithubPrsDashboard(): {
    templating: { list: Array<{ name: string; type: string; datasource?: { type?: string }; query?: { rawQueryText?: string } }> };
  } {
    return JSON.parse(readFileSync(githubPrsPath, "utf8"));
  }

  it("declares $scope as a dynamic, query-backed variable against the local reporting DB, not a hardcoded custom list", () => {
    const vars = readGithubPrsDashboard().templating.list;
    const scope = vars.find((v) => v.name === "scope");

    expect(scope?.type).toBe("query");
    expect(scope?.datasource?.type).toBe("frser-sqlite-datasource");
    expect(scope?.query?.rawQueryText).toContain("review_targets");
    expect(scope?.query?.rawQueryText).not.toContain("JSONbored");
    expect(scope?.query?.rawQueryText).not.toContain("org:");
  });

  (sqliteCliAvailable ? it : it.skip)("builds only explicit repo-scoped options and never an org-wide All repos value", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(
      db,
      `
      CREATE TABLE review_targets (repo TEXT NOT NULL);
      INSERT INTO review_targets (repo) VALUES ('acme/widgets'), ('acme/gadgets'), ('acme/widgets');
    `,
    );

    const rawQueryText = readGithubPrsDashboard().templating.list.find((v) => v.name === "scope")?.query?.rawQueryText;
    if (!rawQueryText) throw new Error("missing $scope rawQueryText");
    const rows = sqlite(db, rawQueryText).split("\n");

    expect(rows).toEqual(["1|acme/gadgets|repo:acme/gadgets", "1|acme/widgets|repo:acme/widgets"]);
    expect(rows.join("\n")).not.toContain("org:acme");
    expect(rows.join("\n")).not.toContain("All repos");
  });
});
