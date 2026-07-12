import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseMetricsExportArgs,
  runMetricsExport,
} from "../../packages/gittensory-miner/lib/observability-cli.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { initPredictionLedger } from "../../packages/gittensory-miner/lib/prediction-ledger.js";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-observe-cli-"));
  roots.push(root);
  return root;
}

function fakePredictionLedger(rows: Array<{ conclusion: string }>) {
  return { readPredictions: () => rows, close: vi.fn() };
}

function fakeEventLedger(events: Array<{ type: string }>) {
  return { readEvents: () => events, close: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stubEnv(key: string, value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("gittensory-miner metrics export CLI (#4839)", () => {
  describe("parseMetricsExportArgs", () => {
    it("defaults to no file and stdout=false", () => {
      expect(parseMetricsExportArgs([])).toEqual({ file: null, stdout: false });
    });

    it("parses --stdout and --file (trimming the value)", () => {
      expect(parseMetricsExportArgs(["--stdout"])).toEqual({ file: null, stdout: true });
      expect(parseMetricsExportArgs(["--file", "  /a/b.prom  "])).toEqual({ file: "/a/b.prom", stdout: false });
    });

    it("rejects --file without a value, unknown options, and stray positionals", () => {
      expect(parseMetricsExportArgs(["--file"])).toEqual({ error: expect.stringContaining("Usage:") });
      expect(parseMetricsExportArgs(["--file", "--stdout"])).toEqual({ error: expect.stringContaining("Usage:") });
      expect(parseMetricsExportArgs(["--bogus"])).toEqual({ error: "Unknown option: --bogus" });
      expect(parseMetricsExportArgs(["stray"])).toEqual({ error: expect.stringContaining("Usage:") });
    });
  });

  it("prints the unified exposition to stdout when no file is configured", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = runMetricsExport([], {
      env: {},
      now: () => 1_720_000_000_000,
      initPredictionLedger: () => fakePredictionLedger([{ conclusion: "merge" }]),
      initEventLedger: () => fakeEventLedger([{ type: "discovered_issue" }]),
    });
    expect(code).toBe(0);
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain("gittensory_miner_build_info");
    expect(out).toContain("gittensory_miner_scrape_timestamp_seconds 1720000000");
    expect(out).toContain('gittensory_miner_predictions_total{conclusion="merge"}');
    expect(out).toContain('gittensory_miner_events_total{type="discovered_issue"}');
  });

  it("writes atomically to the --file path, taking precedence over the env var", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writes: Array<[string, string]> = [];
    const code = runMetricsExport(["--file", "  /out/flag.prom  "], {
      env: { GITTENSORY_MINER_METRICS_FILE: "/out/env.prom" },
      now: () => 0,
      initPredictionLedger: () => fakePredictionLedger([]),
      initEventLedger: () => fakeEventLedger([]),
      writeMetricsTextfile: (document, filePath) => {
        writes.push([document, filePath]);
        return filePath;
      },
    });
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toBe("/out/flag.prom");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("wrote metrics exposition to /out/flag.prom"));
  });

  it("writes to the GITTENSORY_MINER_METRICS_FILE path when no --file is given", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let target = "";
    const code = runMetricsExport([], {
      env: { GITTENSORY_MINER_METRICS_FILE: "/env/only.prom" },
      now: () => 0,
      initPredictionLedger: () => fakePredictionLedger([]),
      initEventLedger: () => fakeEventLedger([]),
      writeMetricsTextfile: (_document, filePath) => {
        target = filePath;
        return filePath;
      },
    });
    expect(code).toBe(0);
    expect(target).toBe("/env/only.prom");
  });

  it("--stdout forces stdout even when a file is configured", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.fn();
    const code = runMetricsExport(["--stdout"], {
      env: { GITTENSORY_MINER_METRICS_FILE: "/env/only.prom" },
      now: () => 0,
      initPredictionLedger: () => fakePredictionLedger([]),
      initEventLedger: () => fakeEventLedger([]),
      writeMetricsTextfile: write,
    });
    expect(code).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns 2 on a parse error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runMetricsExport(["--file"], {})).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("surfaces a thrown Error message and exits non-zero", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runMetricsExport(["--file", "/out/m.prom"], {
      env: {},
      initPredictionLedger: () => fakePredictionLedger([]),
      initEventLedger: () => fakeEventLedger([]),
      writeMetricsTextfile: () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith("disk full");
  });

  it("stringifies a non-Error throw", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runMetricsExport(["--file", "/out/m.prom"], {
      env: {},
      initPredictionLedger: () => fakePredictionLedger([]),
      initEventLedger: () => fakeEventLedger([]),
      writeMetricsTextfile: () => {
        throw "boom-string";
      },
    });
    expect(code).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith("boom-string");
  });

  it("opens and closes its own default ledgers when none are injected", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = tempRoot();
    stubEnv("GITTENSORY_MINER_PREDICTION_LEDGER_DB", join(root, "prediction-ledger.sqlite3"));
    stubEnv("GITTENSORY_MINER_EVENT_LEDGER_DB", join(root, "event-ledger.sqlite3"));

    // Seed one row in each real ledger so the rendered document is non-trivial.
    const prediction = initPredictionLedger();
    prediction.appendPrediction({
      repoFullName: "acme/widgets",
      targetId: 1,
      conclusion: "merge",
      pack: "default",
      readinessScore: 90,
      blockerCodes: [],
      warningCodes: [],
      engineVersion: "test",
    });
    prediction.close();
    const events = initEventLedger();
    events.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: {} });
    events.close();

    const code = runMetricsExport(["--stdout"], { now: () => 0 });
    expect(code).toBe(0);
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain('gittensory_miner_predictions_total{conclusion="merge"}');
    expect(out).toContain('gittensory_miner_events_total{type="discovered_issue"}');
  });
});
