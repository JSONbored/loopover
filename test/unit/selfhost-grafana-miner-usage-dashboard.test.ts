import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Panel = {
  id?: number;
  type?: string;
  title?: string;
  datasource?: { type?: string; uid?: string };
  options?: { content?: string };
  targets?: { queryText?: string; rawQueryText?: string }[];
};
type Dashboard = { uid: string; title: string; tags: string[]; panels: Panel[] };

const dashboardPath = join(process.cwd(), "grafana/dashboards/miner-usage.json");
const readDashboard = (): Dashboard => JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;

// The redacted AMS reporting exports (export-ams-reporting-db.sh, #5184) drop payload_json and everything derived
// from it (provider/cost/tokens). None of those must ever appear in a query, or the panel would silently
// reference a column the datasource does not have.
const REDACTED_OR_ABSENT = ["payload_json", "reason", "provider", "cost", "tokens", "token"];
const AMS_UIDS = new Set(["ams-attempt-log", "ams-prediction-ledger"]);

const queries = (d = readDashboard()): string[] =>
  d.panels.flatMap((p) => (p.targets ?? []).map((t) => t.queryText ?? "").filter(Boolean));

describe("LoopOver — AMS (miner) usage dashboard (#5185)", () => {
  it("declares the expected uid/title/tags", () => {
    const d = readDashboard();
    expect(d.uid).toBe("loopover-miner-usage");
    expect(d.title).toMatch(/AMS/);
    expect(d.tags).toEqual(expect.arrayContaining(["ams", "miner", "observability"]));
  });

  it("every query panel reads ONLY the redacted AMS SQLite datasources (never scrapes Prometheus or mounts live ledgers)", () => {
    for (const panel of readDashboard().panels) {
      if (panel.type === "text") continue;
      expect(panel.datasource?.type, panel.title).toBe("frser-sqlite-datasource");
      expect(AMS_UIDS.has(panel.datasource?.uid ?? ""), `${panel.title}: ${panel.datasource?.uid}`).toBe(true);
    }
  });

  it("queries only the two real reporting tables and only their existing (redacted-export) columns", () => {
    for (const q of queries()) {
      expect(/\bFROM\s+(attempt_log_events|predictions)\b/.test(q), q).toBe(true);
    }
  });

  it("INVARIANT: no query references a redacted/absent column — payload_json and its derivations (provider/cost/tokens) are never queried", () => {
    for (const q of queries()) {
      for (const col of REDACTED_OR_ABSENT) {
        expect(q.includes(col), `query must not reference '${col}': ${q}`).toBe(false);
      }
    }
  });

  it("uses the engine's real attempt-outcome event_type values, not invented ones", () => {
    const all = queries().join("\n");
    expect(all).toContain("attempt_succeeded");
    expect(all).toContain("attempt_failed");
    expect(all).toContain("attempt_aborted");
  });

  it("documents the data-scope limitation (why no per-provider cost/token panels) in a note panel", () => {
    const note = readDashboard().panels.find((p) => p.type === "text");
    expect(note?.options?.content).toMatch(/payload_json/);
    expect(note?.options?.content).toMatch(/provider|cost|token/i);
  });

  it("gives every panel a unique id", () => {
    const ids = readDashboard().panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
