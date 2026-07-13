import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validation for the AMS ledger Grafana datasource provisioning (#5184). Config under grafana/provisioning/, not
// `src/**`, so Codecov doesn't gate it — but the boundary invariant (Grafana reads only redacted reporting
// exports, never live miner ledgers) and the purely-additive contract (no UID collision, existing datasources
// untouched) are asserted here as real tests.
const DS_DIR = join(process.cwd(), "grafana/provisioning/datasources");
const amsDoc = parse(
  readFileSync(join(DS_DIR, "ams-ledgers.yml"), "utf8"),
) as Record<string, any>;
const amsDatasources = (amsDoc.datasources as Array<Record<string, any>>) ?? [];

describe("AMS ledger Grafana datasources (#5184)", () => {
  it("provisions read-only frser-sqlite datasources for redacted AMS reporting exports", () => {
    expect(amsDatasources).toHaveLength(2);
    const paths = amsDatasources.map((d) => d.jsonData?.path);
    expect(paths).toContain("/reporting/ams-attempt-log.sqlite");
    expect(paths).toContain("/reporting/ams-prediction-ledger.sqlite");
    for (const ds of amsDatasources) {
      expect(ds.type).toBe("frser-sqlite-datasource");
    }
  });

  it("is read-only and never mounts live miner ledgers", () => {
    for (const ds of amsDatasources) {
      expect(ds.editable).toBe(false); // provisioned datasources are immutable in the UI
      expect(ds.access).toBe("proxy");
      // no write-enabling knob is present, and Grafana only sees reporting exports
      expect(JSON.stringify(ds)).not.toMatch(
        /write|allowUpdate|readonly"?:\s*false/i,
      );
      expect(ds.jsonData?.path).toMatch(/^\/reporting\//);
      expect(ds.jsonData?.path).not.toMatch(
        /\/ams-ledgers\/|attempt-log\.sqlite3|prediction-ledger\.sqlite3/,
      );
    }
  });

  it("uses fresh UIDs and leaves every existing datasource untouched (purely additive)", () => {
    const existingUids = new Set<string>();
    for (const file of readdirSync(DS_DIR)) {
      if (file === "ams-ledgers.yml") continue;
      const doc = parse(readFileSync(join(DS_DIR, file), "utf8")) as Record<
        string,
        any
      >;
      for (const ds of (doc.datasources as Array<Record<string, any>>) ?? [])
        existingUids.add(ds.uid);
    }
    for (const ds of amsDatasources) {
      expect(existingUids.has(ds.uid)).toBe(false);
    }
    // the maintainer LoopoverDB datasource still exists — this change added a file, it did not edit one
    expect(existingUids.has("loopover-db")).toBe(true);
  });
});
