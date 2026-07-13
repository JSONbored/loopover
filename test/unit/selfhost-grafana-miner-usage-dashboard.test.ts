import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #5185: per-provider coding-agent (claude-cli/codex-cli/agent-sdk) usage dashboard for AMS (the miner), reading
// the redacted attempt_outcome_summary rows the AMS reporting export exposes (#5637). Mirrors
// selfhost-grafana-ai-usage-dashboard.test.ts's real-sqlite3-execution style for the same reason: a Grafana
// panel's queryText is opaque to `tsc`/eslint -- running it for real is the only way to catch a broken query
// before an operator does.

type DashboardTarget = { expr?: string; queryText?: string; rawQueryText?: string };
type DashboardPanel = {
  id?: number;
  title?: string;
  type?: string;
  description?: string;
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
type DashboardLink = { title?: string; type?: string; url?: string };
type Dashboard = {
  uid: string;
  title: string;
  tags: string[];
  links: DashboardLink[];
  panels: DashboardPanel[];
  templating: { list: TemplateVar[] };
};

const dashboardPath = join(process.cwd(), "grafana/dashboards/miner-usage.json");
const aiUsageDashboardPath = join(process.cwd(), "grafana/dashboards/ai-usage.json");
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

function allTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels.flatMap((panel) => panel.targets ?? []);
}

function targetForPanel(panelId: number): DashboardTarget {
  const panel = readDashboard().panels.find((candidate) => candidate.id === panelId);
  const target = panel?.targets?.[0];
  if (!target?.queryText) throw new Error(`missing SQL query target for panel ${panelId}`);
  return target;
}

/** Mirrors selfhost-grafana-ai-usage-dashboard.test.ts's own helper: default $provider to "All" and expand the
 *  time-range placeholders to a fixed window, simulating Grafana's own template-variable substitution for a
 *  direct sqlite3 CLI run. */
function expandGrafanaRange(query: string): string {
  const from = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-07-02T00:00:00Z") / 1000);
  return query
    .replaceAll(timeFrom, String(from))
    .replaceAll(timeTo, String(to))
    .replaceAll("${provider:sqlstring}", "'$__all'");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function substituteProvider(query: string, value: string): string {
  return query.replaceAll("${provider:sqlstring}", sqlString(value));
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-grafana-miner-usage-"));
  tmpRoots.push(dir);
  return dir;
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("LoopOver — Miner usage (AMS) dashboard (#5185)", () => {
  it("declares the expected uid/title/tags", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("loopover-miner-usage");
    expect(dashboard.title).toBe("LoopOver — Miner usage (AMS)");
    expect(dashboard.tags).toEqual(["loopover", "miner", "ams"]);
  });

  it("declares a single dashboard (a $provider template variable), not one dashboard per provider", () => {
    const dashboard = readDashboard();
    const providerVar = dashboard.templating.list.find((v) => v.name === "provider");
    expect(providerVar).toBeDefined();
    expect(providerVar?.type).toBe("query");
    expect(providerVar?.datasource?.type).toBe("frser-sqlite-datasource");
    expect(providerVar?.datasource?.uid).toBe("ams-attempt-log");
    expect(providerVar?.query?.rawQueryText).toBe(
      "SELECT DISTINCT provider FROM attempt_log_events WHERE event_type = 'attempt_outcome_summary' AND provider IS NOT NULL ORDER BY provider",
    );
    expect(providerVar?.includeAll).toBe(true);
    // Only one templating variable exists -- no separate per-provider dashboard files either.
    expect(dashboard.templating.list).toHaveLength(1);
  });

  it("queries only the AMS Attempt Log SQLite datasource -- never Prometheus, never scraped metrics", () => {
    const dashboard = readDashboard();
    for (const panel of dashboard.panels) {
      if (panel.type === "row") continue;
      expect(panel.datasource?.type, panel.title).toBe("frser-sqlite-datasource");
      expect(panel.datasource?.uid, panel.title).toBe("ams-attempt-log");
      for (const target of panel.targets ?? []) {
        expect(target.expr, panel.title).toBeUndefined();
        expect(target.queryText, panel.title).toBeTruthy();
      }
    }
  });

  it("INVARIANT: never mixes ORB metrics and AMS metrics in the same panel", () => {
    const targets = allTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.queryText).toContain("attempt_log_events");
      expect(target.queryText).not.toContain("ai_usage_events");
      expect(target.queryText).not.toMatch(/loopover_ai_|claude_code_/);
    }
    // And the reverse: ai-usage.json's own targets never reference the AMS table.
    const orbDashboard = JSON.parse(readFileSync(aiUsageDashboardPath, "utf8")) as Dashboard;
    const orbTargets = orbDashboard.panels.flatMap((panel) => panel.targets ?? []);
    for (const target of orbTargets) {
      if (target.queryText) expect(target.queryText).not.toContain("attempt_log_events");
    }
  });

  it("scopes every panel query to event_type='attempt_outcome_summary', $provider, AND the selected time window", () => {
    for (const target of allTargets()) {
      expect(target.queryText).toContain("event_type = 'attempt_outcome_summary'");
      expect(target.queryText).toContain("(${provider:sqlstring} = '$__all' OR provider = ${provider:sqlstring})");
      expect(target.queryText).toContain("unixepoch(created_at) >=");
      expect(target.queryText).toContain("unixepoch(created_at) <");
    }
  });

  it("uses Grafana SQL-string formatting for $provider before embedding it in SQLite (no raw '$provider' interpolation bug)", () => {
    const sqlSources = [
      readDashboard().templating.list.find((v) => v.name === "provider")?.query,
      ...allTargets(),
    ];
    for (const source of sqlSources) {
      if (source?.queryText) expect(source.queryText).not.toMatch(/'\$provider'/);
      if (source?.rawQueryText) expect(source.rawQueryText).not.toMatch(/'\$provider'/);
    }
  });

  it("cross-references the ORB AI-usage dashboard via a links entry, and ai-usage.json links back (#5185 req 6)", () => {
    const dashboard = readDashboard();
    expect(dashboard.links).toHaveLength(1);
    expect(dashboard.links[0]?.type).toBe("link");
    expect(dashboard.links[0]?.url).toBe("/d/loopover-ai-usage/loopover-ai-usage");

    const orbDashboard = JSON.parse(readFileSync(aiUsageDashboardPath, "utf8")) as Dashboard;
    const backLink = orbDashboard.links.find((link) => link.url === "/d/loopover-miner-usage/loopover-miner-usage");
    expect(backLink).toBeDefined();
    expect(backLink?.type).toBe("link");
  });

  it("does not modify any other panel/datasource/variable already in ai-usage.json (additive-only change)", () => {
    const orbDashboard = JSON.parse(readFileSync(aiUsageDashboardPath, "utf8")) as Dashboard;
    expect(orbDashboard.uid).toBe("loopover-ai-usage");
    expect(orbDashboard.panels.length).toBeGreaterThan(0);
    // The pre-existing $provider/$feature/$model/$claudeModel variables are untouched -- only a `links` entry
    // was added.
    const names = orbDashboard.templating.list.map((v) => v.name).sort();
    expect(names).toEqual(["claudeModel", "feature", "model", "provider"]);
  });

  (sqliteCliAvailable ? it : it.skip)(
    "actually narrows every panel by $provider, and 'All' still sums everything, across real seeded data",
    () => {
      const root = tmpRoot();
      const db = join(root, "reporting.sqlite");
      sqlite(
        db,
        `
        CREATE TABLE attempt_log_events (
          id INTEGER PRIMARY KEY,
          seq INTEGER NOT NULL,
          attempt_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          action_class TEXT NOT NULL,
          mode TEXT NOT NULL,
          provider TEXT,
          cost_usd REAL,
          tokens_used INTEGER,
          created_at TEXT NOT NULL
        );
        INSERT INTO attempt_log_events (id, seq, attempt_id, event_type, action_class, mode, provider, cost_usd, tokens_used, created_at) VALUES
          (1, 1, 'a-1', 'attempt_outcome_summary', 'attempt_submitted', 'live', 'claude-cli', 0.42, NULL, '2026-07-01T12:00:00Z'),
          (2, 2, 'a-2', 'attempt_outcome_summary', 'attempt_abandon', 'live', 'claude-cli', 0.10, NULL, '2026-07-01T13:00:00Z'),
          (3, 3, 'a-3', 'attempt_outcome_summary', 'attempt_submitted', 'live', 'codex-cli', 0, NULL, '2026-07-01T14:00:00Z'),
          (4, 4, 'a-4', 'attempt_outcome_summary', 'attempt_stale', 'live', 'agent-sdk', 1.5, NULL, '2026-07-01T15:00:00Z'),
          -- A non-outcome-summary, non-terminal event on attempt a-1 -- provider is NULL, and it must never
          -- leak into any of the per-provider aggregates or counts above (event_type filter must exclude it).
          (5, 1, 'a-1', 'attempt_started', 'iterate_loop', 'live', NULL, NULL, NULL, '2026-07-01T11:59:00Z');
      `,
      );

      const totalAttemptsQuery = targetForPanel(2).queryText!;
      const allAttempts = sqlite(db, expandGrafanaRange(totalAttemptsQuery));
      expect(allAttempts).toBe("4");
      const claudeOnly = sqlite(db, expandGrafanaRange(substituteProvider(totalAttemptsQuery, "claude-cli")));
      expect(claudeOnly).toBe("2");

      const succeededQuery = targetForPanel(3).queryText!;
      expect(sqlite(db, expandGrafanaRange(succeededQuery))).toBe("2");
      expect(sqlite(db, expandGrafanaRange(substituteProvider(succeededQuery, "codex-cli")))).toBe("1");

      const costQuery = targetForPanel(4).queryText!;
      expect(sqlite(db, expandGrafanaRange(costQuery))).toBe("2.02");

      const tokensQuery = targetForPanel(5).queryText!;
      expect(sqlite(db, expandGrafanaRange(tokensQuery))).toBe("0");

      const byProviderQuery = targetForPanel(7).queryText!;
      const byProviderRows = sqlite(db, expandGrafanaRange(byProviderQuery)).split("\n");
      expect(byProviderRows).toHaveLength(3);
      expect(byProviderRows).toContain("claude-cli|1|1|2|0.52|0");
      expect(byProviderRows).toContain("codex-cli|1|0|1|0.0|0");
      expect(byProviderRows).toContain("agent-sdk|0|1|1|1.5|0");

      const recentQuery = targetForPanel(10).queryText!;
      const recentOutput = sqlite(db, expandGrafanaRange(recentQuery));
      const recentRows = recentOutput.split("\n");
      // 4 rows -- the attempt_started/NULL-provider row on the same attempt_id must never appear here.
      expect(recentRows).toHaveLength(4);
      expect(recentOutput).not.toContain("attempt_started");
      expect(recentOutput).toContain("2026-07-01T12:00:00Z|a-1|claude-cli|attempt_submitted|live|0.42|");
    },
  );
});
