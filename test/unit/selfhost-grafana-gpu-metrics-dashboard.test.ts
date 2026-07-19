import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type DashboardTarget = { expr?: string };
type DashboardPanel = { title?: string; targets?: DashboardTarget[] };
type Dashboard = { panels: DashboardPanel[] };

const dashboardPath = join(process.cwd(), "grafana/dashboards/gpu-metrics.json");

function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}

describe("LoopOver GPU Metrics Grafana dashboard", () => {
  // REGRESSION: #5522 hard-cutover renamed this dashboard's 3 loopover_ai_provider_* queries from their
  // pre-rebrand gittensory_ai_provider_* names with no historical fallback, so every panel here only ever
  // showed data recorded after that cutover -- confirmed live, both metric names have real historical series
  // in Prometheus going back well past the cutover. Mirrors the (loopover_x or gittensory_x) union fix
  // already shipped for grafana/dashboards/loopover-selfhost.json (#6779/#6787) and ai-usage.json (#5522 follow-up).
  it("unions every loopover_ai_provider_* query with its pre-rebrand gittensory_ai_provider_* counterpart for historical continuity", () => {
    const targets = readDashboard().panels.flatMap((panel) => panel.targets ?? []);

    for (const target of targets) {
      if (!target.expr?.includes("loopover_ai_provider")) continue;
      expect(target.expr, `missing historical union: ${target.expr}`).toContain("gittensory_ai_provider");
      expect(target.expr, `invalid PromQL -- label matcher applied after a closing paren: ${target.expr}`).not.toMatch(/\)\s*\{/);
    }

    expect(
      targets.some(
        (t) =>
          t.expr ===
          "sum by (provider, request_kind) ((rate(loopover_ai_provider_request_duration_seconds_count[5m]) or rate(gittensory_ai_provider_request_duration_seconds_count[5m])))",
      ),
    ).toBe(true);
    expect(
      targets.some(
        (t) =>
          t.expr ===
          "histogram_quantile(0.50, sum by (le) ((rate(loopover_ai_provider_request_duration_seconds_bucket[5m]) or rate(gittensory_ai_provider_request_duration_seconds_bucket[5m]))))",
      ),
    ).toBe(true);
    expect(
      targets.some(
        (t) =>
          t.expr ===
          "histogram_quantile(0.95, sum by (le) ((rate(loopover_ai_provider_request_duration_seconds_bucket[5m]) or rate(gittensory_ai_provider_request_duration_seconds_bucket[5m]))))",
      ),
    ).toBe(true);
    expect(
      targets.some(
        (t) =>
          t.expr ===
          "histogram_quantile(0.99, sum by (le) ((rate(loopover_ai_provider_request_duration_seconds_bucket[5m]) or rate(gittensory_ai_provider_request_duration_seconds_bucket[5m]))))",
      ),
    ).toBe(true);
    expect(
      targets.some(
        (t) =>
          t.expr ===
          "sum by (provider, request_kind) ((rate(loopover_ai_provider_request_errors_total[5m]) or rate(gittensory_ai_provider_request_errors_total[5m])))",
      ),
    ).toBe(true);
  });

  it("declares a stable title and uid", () => {
    const dashboard = readDashboard() as Dashboard & { title?: string; uid?: string };

    expect(dashboard.title).toBe("LoopOver — GPU Metrics");
    expect(dashboard.uid).toBe("loopover-gpu");
  });
});
