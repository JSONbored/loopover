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
