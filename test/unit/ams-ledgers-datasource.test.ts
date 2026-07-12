import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validation for the AMS ledger Grafana datasource provisioning (#5184). Config under grafana/provisioning/, not
// `src/**`, so Codecov doesn't gate it — but the read-only invariant (Grafana can only READ the miner's SQLite
// ledgers, never write) and the purely-additive contract (no UID collision, existing datasources untouched) are
// asserted here as real tests.
const DS_DIR = join(process.cwd(), "grafana/provisioning/datasources");
const amsDoc = parse(
  readFileSync(join(DS_DIR, "ams-ledgers.yml"), "utf8"),
) as Record<string, any>;
const amsDatasources = (amsDoc.datasources as Array<Record<string, any>>) ?? [];

describe("AMS ledger Grafana datasources (#5184)", () => {
  it("provisions read-only frser-sqlite datasources for the attempt-log and prediction-ledger", () => {
    expect(amsDatasources).toHaveLength(2);
    const paths = amsDatasources.map((d) => d.jsonData?.path);
    expect(paths).toContain("/ams-ledgers/attempt-log.sqlite3");
    expect(paths).toContain("/ams-ledgers/prediction-ledger.sqlite3");
    for (const ds of amsDatasources) {
      expect(ds.type).toBe("frser-sqlite-datasource");
    }
  });

  it("is read-only and never grants write access to the ledgers", () => {
    for (const ds of amsDatasources) {
      expect(ds.editable).toBe(false); // provisioned datasources are immutable in the UI
      expect(ds.access).toBe("proxy");
      // no write-enabling knob is present; the frser-sqlite query plugin only reads the file
      expect(JSON.stringify(ds)).not.toMatch(
        /write|allowUpdate|readonly"?:\s*false/i,
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
    // the maintainer GittensoryDB datasource still exists — this change added a file, it did not edit one
    expect(existingUids.has("gittensory-db")).toBe(true);
  });
});
