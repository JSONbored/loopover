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

const dashboardPath = join(process.cwd(), "grafana/dashboards/rees-metrics.json");

function readDashboard(): Dashboard {
  return JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
}

function allTargets(dashboard = readDashboard()): DashboardTarget[] {
  return dashboard.panels.flatMap((panel) => panel.targets ?? []);
}

describe("Gittensory — REES (review-enrichment) dashboard (#5367)", () => {
  it("declares the expected uid/title/tags", () => {
    const dashboard = readDashboard();
    expect(dashboard.uid).toBe("gittensory-rees");
    expect(dashboard.title).toBe("Gittensory — REES (review-enrichment)");
    expect(dashboard.tags).toEqual(["gittensory", "rees", "observability"]);
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

  it("uses the real metric names REES's own metrics.ts registers (rees_enrich_requests_total/rees_enrich_request_duration_seconds/rees_analyzer_runs_total/rees_analyzer_duration_seconds)", () => {
    const targets = allTargets();
    expect(targets.some((t) => t.expr?.includes("rees_enrich_requests_total"))).toBe(true);
    expect(targets.some((t) => t.expr?.includes("rees_enrich_request_duration_seconds_bucket"))).toBe(true);
    expect(targets.some((t) => t.expr?.includes("rees_analyzer_runs_total"))).toBe(true);
    expect(targets.some((t) => t.expr?.includes("rees_analyzer_duration_seconds_bucket"))).toBe(true);
  });

  it("excludes the healthy 'ok' status from the non-ok outcome-rate panel", () => {
    const target = allTargets().find((t) => t.expr?.includes("rees_enrich_requests_total{status"));
    expect(target?.expr).toContain('status!="ok"');
  });

  it("bounds every panel that breaks down BY analyzer with topk, so a future analyzer influx can't unbound the panel legend", () => {
    // Deliberately excludes the "outcomes by status" panel: it groups by the fixed 5-value AnalyzerStatus
    // enum, not by analyzer name, so it can never grow unbounded and needs no topk.
    const perAnalyzerTargets = allTargets().filter((t) => t.expr?.includes("by (analyzer)") || t.expr?.includes("by (le, analyzer)"));
    expect(perAnalyzerTargets.length).toBeGreaterThan(0);
    for (const target of perAnalyzerTargets) {
      expect(target.expr).toContain("topk(");
    }
  });
});
