import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type DashboardTarget = { expr?: string; legendFormat?: string };
type DashboardPanel = {
  id?: number;
  title?: string;
  type?: string;
  description?: string;
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
};
type Dashboard = {
  uid: string;
  title: string;
  tags: string[];
  panels: DashboardPanel[];
};

const dashboardPath = join(process.cwd(), "grafana/dashboards/browserless-metrics.json");

function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}

function allTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels.flatMap((panel) => panel.targets ?? []);
}

describe("LoopOver — Browserless (visual review) dashboard (#5368)", () => {
  it("declares the expected uid/title/tags", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("loopover-browserless");
    expect(dashboard.title).toBe("LoopOver — Browserless (visual review)");
    expect(dashboard.tags).toEqual(["loopover", "browserless", "observability"]);
  });

  it("every panel target uses the Prometheus datasource variable, never a hardcoded uid", () => {
    const dashboard = readDashboard();
    for (const panel of dashboard.panels) {
      if (panel.type === "row") continue;
      expect(panel.datasource?.type, panel.title).toBe("prometheus");
      expect(panel.datasource?.uid, panel.title).toBe("${DS_PROMETHEUS}");
      for (const target of panel.targets ?? []) {
        expect(target.expr, panel.title).toBeTruthy();
      }
    }
  });

  it("uses the real metric names browserless-metrics.sh emits", () => {
    const targets = allTargets();
    const expectedMetrics = [
      "browserless_exporter_last_scrape_success",
      "browserless_sample_timestamp_seconds",
      "browserless_queued",
      "browserless_running",
      "browserless_max_concurrent",
      "browserless_rejected",
      "browserless_errors",
      "browserless_timedout",
      "browserless_unauthorized",
      "browserless_unhealthy",
      "browserless_successful",
      "browserless_session_mean_time_ms",
      "browserless_cpu_ratio",
      "browserless_memory_ratio",
    ];
    for (const metric of expectedMetrics) {
      expect(targets.some((t) => t.expr?.includes(metric)), metric).toBe(true);
    }
  });

  it("surfaces exporter-scrape health separately from browserless's own sample freshness", () => {
    const targets = allTargets();
    expect(targets.some((t) => t.expr === "browserless_exporter_last_scrape_success")).toBe(true);
    expect(targets.some((t) => t.expr === "time() - browserless_sample_timestamp_seconds")).toBe(true);
  });
});
