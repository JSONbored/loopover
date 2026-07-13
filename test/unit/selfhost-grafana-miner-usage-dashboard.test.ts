import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMS_MINER_USAGE_PROVIDER_NAMES,
  buildAmsMinerUsageProviderSqlFilter,
  buildAmsMinerUsageProviderWhereClause,
} from "@loopover/engine";

type DashboardTarget = {
  queryText?: string;
  rawQueryText?: string;
};

type DashboardPanel = {
  id?: number;
  title?: string;
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
};

type TemplateVar = {
  name: string;
  type: string;
  datasource?: { type?: string; uid?: string };
  query?: { queryText?: string; rawQueryText?: string };
  includeAll?: boolean;
};

type Dashboard = {
  uid: string;
  title: string;
  description?: string;
  panels: DashboardPanel[];
  templating: { list: TemplateVar[] };
};

const dashboardsDir = join(process.cwd(), "grafana/dashboards");
const dashboardPath = join(dashboardsDir, "miner-usage.json");
const timeFrom = "${__from:date:seconds}";
const timeTo = "${__to:date:seconds}";
const tmpRoots: string[] = [];

const sqliteCliAvailable = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}

function sqliteTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .filter((target) => typeof target.queryText === "string" && target.queryText.includes("attempt_log_events"));
}

function expandGrafanaRange(query: string, provider = "$__all"): string {
  const from = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-07-02T00:00:00Z") / 1000);
  const providerSql = provider === "$__all" ? "'$__all'" : `'${provider.replaceAll("'", "''")}'`;
  return query
    .replaceAll(timeFrom, String(from))
    .replaceAll(timeTo, String(to))
    .replaceAll("${provider:sqlstring}", providerSql);
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-grafana-miner-usage-"));
  tmpRoots.push(dir);
  return dir;
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function seedReportingAttemptLog(
  db: string,
  rows: Array<{
    seq: number;
    attemptId: string;
    eventType: string;
    driverProvider: string;
    turnsUsed: number;
    tokensUsed: number;
    costUsd: number;
    createdAt: string;
  }>,
): void {
  sqlite(
    db,
    `
    CREATE TABLE attempt_log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_class TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      driver_provider TEXT,
      turns_used INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0.0
    );
    ${rows
      .map(
        (r) =>
          `INSERT INTO attempt_log_events (seq, attempt_id, event_type, action_class, mode, created_at, driver_provider, turns_used, tokens_used, cost_usd) VALUES (${r.seq}, '${r.attemptId}', '${r.eventType}', 'iterate_loop', 'live', '${r.createdAt}', '${r.driverProvider}', ${r.turnsUsed}, ${r.tokensUsed}, ${r.costUsd});`,
      )
      .join("\n")}
  `,
  );
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Gittensory miner — coding-agent usage dashboard (#5185)", () => {
  it("ships miner-usage.json alongside the ORB dashboards", () => {
    const files = readdirSync(dashboardsDir);
    expect(files).toContain("miner-usage.json");
    expect(files).toContain("ai-usage.json");
  });

  it("cross-references the ORB AI-usage dashboard and scopes panels to ams-attempt-log only", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("gittensory-miner-usage");
    expect(dashboard.description).toContain("/d/loopover-ai-usage");
    expect(dashboard.description).toContain("ams-attempt-log");

    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        if (target.queryText?.includes("attempt_log_events")) {
          expect(panel.datasource?.uid).toBe("ams-attempt-log");
          expect(target.queryText).not.toContain("ai_usage_events");
          expect(target.queryText).not.toContain("loopover-db");
        }
      }
    }
  });

  it("declares a query-backed $provider template variable over driver_provider", () => {
    const providerVar = readDashboard().templating.list.find((v) => v.name === "provider");
    expect(providerVar?.type).toBe("query");
    expect(providerVar?.datasource?.uid).toBe("ams-attempt-log");
    expect(providerVar?.query?.rawQueryText).toContain("SELECT DISTINCT driver_provider FROM attempt_log_events");
    expect(providerVar?.includeAll).toBe(true);
  });

  it("scopes every attempt_log_events panel to $provider and the selected time window", () => {
    const filter = buildAmsMinerUsageProviderSqlFilter();
    const targets = sqliteTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.queryText).toContain(filter);
      expect(target.queryText).toContain("unixepoch(created_at) >=");
      expect(target.queryText).toContain("unixepoch(created_at) <");
      expect(target.queryText).not.toContain("ai_usage_events");
    }
  });

  it("provider-filter helper rejects unknown providers instead of merging every row", () => {
    expect(buildAmsMinerUsageProviderWhereClause("mystery")).toBe("1=0");
    expect(buildAmsMinerUsageProviderWhereClause("claude-cli")).toBe("driver_provider = 'claude-cli'");
  });

  it.skipIf(!sqliteCliAvailable)("executes dashboard SQL against a seeded reporting snapshot", () => {
    const root = tmpRoot();
    const db = join(root, "ams-attempt-log.sqlite");
    seedReportingAttemptLog(db, [
      {
        seq: 1,
        attemptId: "a-1",
        eventType: "attempt_succeeded",
        driverProvider: "claude-cli",
        turnsUsed: 2,
        tokensUsed: 0,
        costUsd: 0.05,
        createdAt: "2026-07-01T12:00:00Z",
      },
      {
        seq: 2,
        attemptId: "a-2",
        eventType: "attempt_failed",
        driverProvider: "codex-cli",
        turnsUsed: 1,
        tokensUsed: 0,
        costUsd: 0.02,
        createdAt: "2026-07-01T13:00:00Z",
      },
    ]);

    const successTarget = sqliteTargets().find((t) => t.queryText?.includes("attempt_succeeded"))!;
    const allSuccesses = sqlite(db, expandGrafanaRange(successTarget.queryText!));
    expect(allSuccesses).toBe("1");

    const scopedSuccesses = sqlite(db, expandGrafanaRange(successTarget.queryText!, "codex-cli"));
    expect(scopedSuccesses).toBe("0");

    const costTarget = sqliteTargets().find((t) => t.queryText?.includes("sum(cost_usd)"))!;
    expect(sqlite(db, expandGrafanaRange(costTarget.queryText!))).toBe("0.07");
  });

  it("documents the three AMS coding-agent providers the dashboard is scoped to", () => {
    expect(AMS_MINER_USAGE_PROVIDER_NAMES).toEqual(["claude-cli", "codex-cli", "agent-sdk"]);
  });
});
