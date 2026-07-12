import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
};

type TemplateVar = {
  name: string;
  type: string;
  datasource?: { type?: string };
  query?: { queryText?: string; rawQueryText?: string; query?: string };
  includeAll?: boolean;
  multi?: boolean;
  allValue?: string;
};

type Dashboard = {
  uid: string;
  title: string;
  panels: DashboardPanel[];
  templating: { list: TemplateVar[] };
};

const dashboardsDir = join(process.cwd(), "grafana/dashboards");
const dashboardPath = join(dashboardsDir, "ai-usage.json");
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

/** Excludes panel 5 ("Events missing real usage") — it's DELIBERATELY not scoped by $provider/$model,
 *  since NULL provider is exactly the condition it exists to surface (see its own dedicated test below). */
function sqliteTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels
    .filter((panel) => panel.id !== 5)
    .flatMap((panel) => panel.targets ?? [])
    .filter((target) => typeof target.queryText === "string" && target.queryText.includes("ai_usage_events"));
}

function targetForPanel(panelId: number): DashboardTarget {
  const panel = readDashboard().panels.find((candidate) => candidate.id === panelId);
  const target = panel?.targets?.[0];
  if (!target?.queryText) throw new Error(`missing SQL query target for panel ${panelId}`);
  return target;
}

/** Simulate Grafana's own template-variable substitution for a direct sqlite3 CLI run: default every
 *  variable to "All" ('$__all' both sides of its OR clause) unless a caller substitutes a real value
 *  first, and expand the time-range placeholders to a fixed window. */
function expandGrafanaRange(query: string): string {
  const from = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-07-02T00:00:00Z") / 1000);
  return query
    .replaceAll(timeFrom, String(from))
    .replaceAll(timeTo, String(to))
    .replaceAll("${provider:sqlstring}", "'$__all'")
    .replaceAll("${feature:sqlstring}", "'$__all'")
    .replaceAll("${model:sqlstring}", "'$__all'");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function substituteSqlString(query: string, variable: "provider" | "feature" | "model", value: string): string {
  return query.replaceAll(`\${${variable}:sqlstring}`, sqlString(value));
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-grafana-ai-usage-"));
  tmpRoots.push(dir);
  return dir;
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Gittensory - AI usage dashboard (Phase B2 consolidation)", () => {
  it("replaces the 3 old AI-usage dashboards, not just adds a 4th", () => {
    const files = readdirSync(dashboardsDir);
    expect(files).toContain("ai-usage.json");
    expect(files).not.toContain("claude-usage.json");
    expect(files).not.toContain("codex-usage.json");
    expect(files).not.toContain("orb-ai-usage.json");
  });

  it("declares dynamic, query-backed $provider/$feature/$model template variables scoped to ai_usage_events, plus a separate $claudeModel for the OTEL section", () => {
    const vars = readDashboard().templating.list;
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));

    expect(byName.provider?.type).toBe("query");
    expect(byName.provider?.datasource?.type).toBe("frser-sqlite-datasource");
    expect(byName.provider?.query?.rawQueryText).toBe("SELECT DISTINCT provider FROM ai_usage_events WHERE provider IS NOT NULL ORDER BY provider");
    expect(byName.provider?.includeAll).toBe(true);

    expect(byName.feature?.type).toBe("query");
    expect(byName.feature?.query?.rawQueryText).toBe("SELECT DISTINCT feature FROM ai_usage_events ORDER BY feature");
    expect(byName.feature?.includeAll).toBe(true);

    expect(byName.model?.type).toBe("query");
    expect(byName.model?.query?.rawQueryText).toContain("SELECT DISTINCT model FROM ai_usage_events WHERE");
    expect(byName.model?.query?.rawQueryText).toContain("${provider:sqlstring}");
    expect(byName.model?.query?.queryText).toContain("SELECT DISTINCT model FROM ai_usage_events WHERE");
    expect(byName.model?.query?.queryText).toContain("${provider:sqlstring}");
    expect(byName.model?.includeAll).toBe(true);

    expect(byName.claudeModel?.type).toBe("query");
    expect(byName.claudeModel?.datasource?.type).toBe("prometheus");
  });

  it("scopes every ai_usage_events panel query to $provider/$feature/$model AND the selected time window", () => {
    const targets = sqliteTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.queryText).toContain("(${provider:sqlstring} = '$__all' OR provider = ${provider:sqlstring})");
      expect(target.queryText).toContain("(${feature:sqlstring} = '$__all' OR feature = ${feature:sqlstring})");
      expect(target.queryText).toContain("(${model:sqlstring} = '$__all' OR model = ${model:sqlstring})");
      expect(target.queryText).toContain("unixepoch(created_at) >=");
      expect(target.queryText).toContain("unixepoch(created_at) <");
    }
  });

  it("scopes the 'events missing real usage' panel by Feature and time only, never by Provider/Model (those are exactly the columns it's trying to catch as absent)", () => {
    const target = targetForPanel(5);
    expect(target.queryText).toContain("(${feature:sqlstring} = '$__all' OR feature = ${feature:sqlstring})");
    expect(target.queryText).not.toContain("${provider:sqlstring}");
    expect(target.queryText).not.toContain("${model:sqlstring}");
    expect(target.queryText).toContain("provider IS NULL");
  });

  it("uses Grafana SQL-string formatting for durable-log template variables before embedding them in SQLite", () => {
    const dashboard = readDashboard();
    const sqlTargets = [
      dashboard.templating.list.find((variable) => variable.name === "model")?.query,
      ...dashboard.panels.flatMap((panel) => panel.targets ?? []),
    ];

    for (const target of sqlTargets) {
      if (target?.queryText?.includes("ai_usage_events")) {
        expect(target.queryText).not.toMatch(/'\$(provider|feature|model)'/);
      }
      if (target?.rawQueryText?.includes("ai_usage_events")) {
        expect(target.rawQueryText).not.toMatch(/'\$(provider|feature|model)'/);
      }
    }
  });

  it("carries over the exact Prometheus expressions from the removed dashboards, byte-for-byte (no copy-paste drift)", () => {
    const targets = readDashboard().panels.flatMap((panel) => panel.targets ?? []);
    // From gittensory.json's removed "AI Usage & Cost" row.
    expect(targets.some((t) => t.expr === "sum by (provider) (gittensory_ai_cost_usd_total) or vector(0)")).toBe(true);
    expect(targets.some((t) => t.expr === "sum by (provider) ((rate(gittensory_ai_input_tokens_total[5m]) + rate(gittensory_ai_output_tokens_total[5m])) * 60)")).toBe(true);
    expect(targets.some((t) => t.expr === "sum by (model, effort) (increase(gittensory_ai_requests_total[1h]))")).toBe(true);
    expect(targets.some((t) => t.expr === "sum by (primary, fallback) (increase(gittensory_ai_review_model_fallback_total[1h]))")).toBe(true);
    // From codex-usage.json.
    expect(targets.some((t) => t.expr === "sum by (model, effort) (increase(gittensory_ai_requests_total{provider=\"codex\"}[$__rate_interval]))")).toBe(true);
    // From claude-usage.json's OTEL section (uses $claudeModel, not $model, to stay independent of the durable-log filters).
    expect(targets.some((t) => t.expr === "sum(last_over_time(claude_code_cost_usage_USD_total{model=~\"$claudeModel\"}[$__range]))")).toBe(true);
  });

  it("keeps the Claude OTEL section on its own $claudeModel variable, never the durable log's $provider/$feature/$model", () => {
    const dashboard = readDashboard();
    const otelRowIndex = dashboard.panels.findIndex((p) => p.title?.includes("Claude Code native OTEL"));
    expect(otelRowIndex).toBeGreaterThan(-1);
    const otelPanels = dashboard.panels.slice(otelRowIndex + 1);
    const otelTargets = otelPanels.flatMap((p) => p.targets ?? []);
    expect(otelTargets.length).toBeGreaterThan(0);
    for (const target of otelTargets) {
      if (target.expr) {
        expect(target.expr).not.toMatch(/\$provider\b|\$feature\b|(?<!claude)\$model\b/);
      }
    }
  });

  (sqliteCliAvailable ? it : it.skip)("actually narrows the durable-log summary panels by provider/feature/model, and 'All' still sums everything", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(
      db,
      `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT,
        effort TEXT,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, provider, status, total_tokens, cost_usd, created_at)
      VALUES
        ('ai_review_pr', 'claude-sonnet-5', 'claude-code', 'ok', 1000, 0.5, '2026-07-01T12:00:00Z'),
        ('ai_slop_pr', 'gpt-5.5', 'codex', 'ok', 500, 0.2, '2026-07-01T13:00:00Z'),
        ('embeddings', 'bge-m3:latest', 'ollama', 'ok', 100, 0, '2026-07-01T14:00:00Z'),
        ('embeddings', 'bge-m3:latest', 'ollama', 'ok', 200, 0, '2026-07-01T15:00:00Z');
    `,
    );

    const totalEventsQuery = targetForPanel(2).queryText!;
    const allEvents = sqlite(db, expandGrafanaRange(totalEventsQuery));
    const ollamaOnly = sqlite(db, expandGrafanaRange(substituteSqlString(totalEventsQuery, "provider", "ollama")));
    const embeddingsOnly = sqlite(db, expandGrafanaRange(substituteSqlString(totalEventsQuery, "feature", "embeddings")));
    const specificModel = sqlite(db, expandGrafanaRange(substituteSqlString(totalEventsQuery, "model", "gpt-5.5")));

    expect(allEvents).toBe("4");
    expect(ollamaOnly).toBe("2");
    expect(embeddingsOnly).toBe("2");
    expect(specificModel).toBe("1");

    const totalTokensQuery = targetForPanel(3).queryText!;
    expect(sqlite(db, expandGrafanaRange(substituteSqlString(totalTokensQuery, "provider", "ollama")))).toBe("300");
  });

  (sqliteCliAvailable ? it : it.skip)("keeps URL-controlled template values inside SQL string literals", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(
      db,
      `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT,
        effort TEXT,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, provider, status, total_tokens, cost_usd, created_at)
      VALUES
        ('embeddings', 'bge-m3:latest', 'ollama', 'ok', 100, 0, '2026-07-01T14:00:00Z'),
        ('ai_review_pr', 'claude-sonnet-5', 'claude-code', 'ok', 1000, 0.5, '2026-07-01T15:00:00Z');
    `,
    );

    const payload = "x' = '$__all' OR 1=1) --";
    const totalEventsQuery = targetForPanel(2).queryText!;
    expect(sqlite(db, expandGrafanaRange(substituteSqlString(totalEventsQuery, "provider", payload)))).toBe("0");
  });

  (sqliteCliAvailable ? it : it.skip)("finds rows missing real usage regardless of which provider/model they came from", () => {
    const root = tmpRoot();
    const db = join(root, "reporting.sqlite");
    sqlite(
      db,
      `
      CREATE TABLE ai_usage_events (
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT,
        effort TEXT,
        status TEXT NOT NULL,
        estimated_neurons INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ai_usage_events (feature, model, provider, status, total_tokens, cost_usd, created_at)
      VALUES
        ('ai_slop_pr', 'byok:anthropic', NULL, 'ok', 0, 0, '2026-07-01T12:00:00Z'),
        ('ai_review_pr', 'claude-sonnet-5', 'claude-code', 'ok', 1000, 0.5, '2026-07-01T13:00:00Z'),
        ('embeddings', 'bge-m3', NULL, 'error', 0, 0, '2026-07-01T14:00:00Z');
    `,
    );

    const missingUsageQuery = targetForPanel(5).queryText!;
    // 'ai_slop_pr' row: provider NULL, status ok -> counted. 'embeddings' row: status='error', not 'ok' -> excluded
    // by the panel's own status='ok' filter (mirrors orb-ai-usage.json's original semantics).
    expect(sqlite(db, expandGrafanaRange(missingUsageQuery))).toBe("1");
  });
});
