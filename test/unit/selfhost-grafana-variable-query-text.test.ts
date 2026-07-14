import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard (2026-07 fix): every "query"-type template variable across every dashboard silently
// returned ZERO options in the live Grafana instance -- confirmed empirically against a running
// frser-sqlite-datasource via POST /api/ds/query -- because the variable's `query` object only carried
// `rawQueryText` (a display/round-trip field), never the `queryText` field the plugin actually needs to
// execute the query. Panel targets were never affected: they already set BOTH fields at the top level (see
// the `rawQueryText === queryText` check on panel targets elsewhere in this suite), which is exactly why
// every table/timeseries panel rendered real data while every $variable dropdown showed a red error icon and
// resolved to nothing -- cascading into "No data"/zeroed panels wherever a panel's WHERE clause referenced
// one of those variables. This test scans every dashboard file, not just the ones fixed today, so a future
// dashboard can never reintroduce this by copying the variable shape without the fix.
//
// SECOND regression guard (same symptom, different field, found live 2026-07-14 after the fix above had
// already shipped): even with queryText present and matching rawQueryText, every $variable dropdown STILL
// resolved to nothing -- confirmed empirically via a live Grafana instance's own error log
// ("Could not unmarshal query" / "cannot unmarshal object into Go struct field queryModel.queryText of type
// string") and fixed by adding `refId` to the variable's `query` object, matching the shape every WORKING
// panel target already uses (`{ refId, queryType, queryText, rawQueryText }`). Without `refId`, the plugin's
// backend can't deserialize the query into its DataQuery model at all -- queryText being present didn't
// matter, because the object never got that far. Confirmed the fix via a direct `/api/ds/query` POST with
// and without `refId` on the same query.
const dashboardsDir = join(process.cwd(), "grafana/dashboards");

type TemplateVar = {
  name: string;
  type: string;
  datasource?: { type?: string };
  query?: { refId?: string; queryText?: string; rawQueryText?: string } | string;
};

function readDashboardFiles(): Array<{ file: string; vars: TemplateVar[] }> {
  return readdirSync(dashboardsDir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const dashboard = JSON.parse(readFileSync(join(dashboardsDir, file), "utf8")) as {
        templating?: { list?: TemplateVar[] };
      };
      return { file, vars: dashboard.templating?.list ?? [] };
    });
}

describe("Grafana dashboards: every query-type template variable actually executes (2026-07 fix)", () => {
  it("every SQL-datasource query variable's `query` object carries queryText, matching rawQueryText", () => {
    const dashboards = readDashboardFiles();
    expect(dashboards.length).toBeGreaterThan(3); // sanity: the scan found real dashboard files

    const violations: string[] = [];
    for (const { file, vars } of dashboards) {
      for (const v of vars) {
        if (v.type !== "query") continue;
        if (typeof v.query !== "object" || v.query === null) continue;
        // Only the frser-sqlite-datasource plugin exhibits this specific missing-queryText bug (confirmed
        // empirically); a Prometheus/other query variable's `query` field is a plain string, not this shape,
        // and is unaffected -- skip anything that isn't this plugin.
        if (v.datasource?.type !== "frser-sqlite-datasource") continue;
        const { queryText, rawQueryText } = v.query;
        if (!queryText) {
          violations.push(`${file}: $${v.name} is missing "queryText" in its query object (rawQueryText alone silently returns zero rows)`);
        } else if (queryText !== rawQueryText) {
          violations.push(`${file}: $${v.name}'s queryText and rawQueryText have diverged ("${queryText}" vs "${rawQueryText}")`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every SQL-datasource query variable's `query` object carries refId, matching a working panel target's shape", () => {
    const dashboards = readDashboardFiles();
    expect(dashboards.length).toBeGreaterThan(3); // sanity: the scan found real dashboard files

    const violations: string[] = [];
    for (const { file, vars } of dashboards) {
      for (const v of vars) {
        if (v.type !== "query") continue;
        if (typeof v.query !== "object" || v.query === null) continue;
        if (v.datasource?.type !== "frser-sqlite-datasource") continue;
        if (!v.query.refId) {
          violations.push(`${file}: $${v.name} is missing "refId" in its query object (the plugin can't deserialize the query at all without it, regardless of queryText)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
