import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// REGRESSION guard (#orb-grafana-datasource-uid-crash, 2026-07-14): a self-host box's Grafana instance
// persists provisioned datasources (including their `uid`) in its own long-lived sqlite database, separate
// from this repo's git history. If a datasource's `uid` here is silently renamed without a corresponding
// one-time migration of that already-deployed instance's own DB row, Grafana's datasource-provisioning
// module hard-fails on boot ("Datasource provisioning error: data source not found") -- crash-looping the
// ENTIRE Grafana container, not just showing one broken panel. This actually happened live: `sqlite.yml`'s
// `LoopoverDB` datasource was renamed `gittensory-db` -> `loopover-db` as part of the loopover rebrand, but
// an already-running box's Grafana DB still had it registered under the old uid, and the very next
// container recreate crashed it outright. Fixed with a one-time `UPDATE data_source SET uid = ...` on that
// instance (not a code change, and not reproducible from a fresh install). This test pins the uids so a
// FUTURE accidental/silent rename here fails CI immediately -- deliberately renaming a datasource still
// requires updating this test, which is the intended prompt to also plan the live-instance migration step.

type DatasourceEntry = { name: string; type: string; uid: string };
type DatasourceFile = { apiVersion: number; datasources: DatasourceEntry[] };

function readDatasources(path: string): DatasourceEntry[] {
  const parsed = parse(readFileSync(path, "utf8")) as DatasourceFile;
  return parsed.datasources;
}

describe("LoopOver — Grafana provisioned datasource uids are pinned (#orb-grafana-datasource-uid-crash)", () => {
  it("sqlite.yml: LoopoverDB stays uid loopover-db", () => {
    const datasources = readDatasources("grafana/provisioning/datasources/sqlite.yml");
    const loopoverDb = datasources.find((d) => d.name === "LoopoverDB");
    expect(loopoverDb?.type).toBe("frser-sqlite-datasource");
    expect(loopoverDb?.uid).toBe("loopover-db");
  });

  it("prometheus.yml/loki.yml/tempo.yml: core observability datasource uids are pinned", () => {
    expect(readDatasources("grafana/provisioning/datasources/prometheus.yml")[0]).toMatchObject({ uid: "prometheus", type: "prometheus" });
    expect(readDatasources("grafana/provisioning/datasources/loki.yml")[0]).toMatchObject({ uid: "loki", type: "loki" });
    expect(readDatasources("grafana/provisioning/datasources/tempo.yml")[0]).toMatchObject({ uid: "tempo", type: "tempo" });
  });

  it("ams-ledgers.yml: redacted AMS reporting datasource uids are pinned", () => {
    const datasources = readDatasources("grafana/provisioning/datasources/ams-ledgers.yml");
    const byName = Object.fromEntries(datasources.map((d) => [d.name, d]));
    expect(byName["AMS Attempt Log"]).toMatchObject({ uid: "ams-attempt-log", type: "frser-sqlite-datasource" });
    expect(byName["AMS Prediction Ledger"]).toMatchObject({ uid: "ams-prediction-ledger", type: "frser-sqlite-datasource" });
  });

  it("every dashboard panel/template-variable datasource uid actually matches a provisioned datasource", () => {
    const provisionedUids = new Set(
      ["ams-ledgers.yml", "loki.yml", "prometheus.yml", "sqlite.yml", "tempo.yml"].flatMap((f) =>
        readDatasources(`grafana/provisioning/datasources/${f}`).map((d) => d.uid),
      ),
    );
    // ${DS_PROMETHEUS}/${DS_SENTRY} are dashboard-level template inputs Grafana resolves at import time,
    // not literal provisioned uids -- excluded the same way every panel-level test in this repo already does.
    provisionedUids.add("${DS_PROMETHEUS}");
    provisionedUids.add("${DS_SENTRY}");
    // "github" (github-prs.json, grafana-github-datasource plugin) is a KNOWN, accepted gap, not an
    // oversight: that plugin needs a live GitHub PAT to configure, which must never be committed as
    // provisioning YAML -- it's set up manually in the Grafana UI on each self-host instance instead, so
    // github-prs.json genuinely has no git-tracked provisioning source of truth. Flagged separately, not
    // silently ignored here.
    provisionedUids.add("github");

    const dashboardsDir = join(process.cwd(), "grafana/dashboards");
    for (const file of readdirSync(dashboardsDir)) {
      const dashboard = JSON.parse(readFileSync(join(dashboardsDir, file), "utf8")) as {
        panels?: Array<{ datasource?: { uid?: string } }>;
        templating?: { list?: Array<{ datasource?: { uid?: string } }> };
      };
      for (const panel of dashboard.panels ?? []) {
        if (panel.datasource?.uid) expect(provisionedUids.has(panel.datasource.uid), `${file}: panel datasource uid "${panel.datasource.uid}"`).toBe(true);
      }
      for (const templateVar of dashboard.templating?.list ?? []) {
        if (templateVar.datasource?.uid) expect(provisionedUids.has(templateVar.datasource.uid), `${file}: template var datasource uid "${templateVar.datasource.uid}"`).toBe(true);
      }
    }
  });
});
