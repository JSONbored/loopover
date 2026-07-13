import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  findUncheckableCases,
  formatBenchmarkReport,
  renderBaselineDocument,
  roundMetric,
  runBenchmark,
  summarizeDurations,
} from "../../packages/gittensory-miner/scripts/benchmark-harness.mjs";

describe("gittensory-miner benchmark harness (#4845)", () => {
  describe("summarizeDurations", () => {
    it("returns all-zero stats for an empty sample", () => {
      expect(summarizeDurations([])).toEqual({
        iterations: 0,
        totalMs: 0,
        meanMs: 0,
        medianMs: 0,
        minMs: 0,
        maxMs: 0,
        opsPerSec: 0,
      });
    });

    it("computes mean/median (odd length) and ops/sec", () => {
      const stats = summarizeDurations([2, 1, 3]);
      expect(stats).toMatchObject({ iterations: 3, totalMs: 6, meanMs: 2, medianMs: 2, minMs: 1, maxMs: 3 });
      expect(stats.opsPerSec).toBeCloseTo(500, 5);
    });

    it("averages the two middle values for an even-length median", () => {
      expect(summarizeDurations([10, 20, 30, 40]).medianMs).toBe(25);
    });

    it("reports zero ops/sec when every duration is zero", () => {
      expect(summarizeDurations([0, 0]).opsPerSec).toBe(0);
    });
  });

  describe("runBenchmark", () => {
    it("times each iteration with the injected clock, after warmup, and labels the group", async () => {
      let tick = 0;
      const calls: string[] = [];
      // now() is called twice per timed iteration (start, end); advance 5ms across each pair.
      const now = () => {
        tick += 5;
        return tick;
      };
      const result = await runBenchmark(
        "case",
        () => {
          calls.push("run");
        },
        { iterations: 3, warmup: 2, now, group: "grp" },
      );
      // 2 warmup + 3 timed invocations of fn.
      expect(calls).toHaveLength(5);
      expect(result).toMatchObject({ name: "case", group: "grp", status: "ok", iterations: 3, meanMs: 5, medianMs: 5 });
    });

    it("falls back to defaults for non-positive iterations/warmup", async () => {
      let runs = 0;
      const now = (() => {
        let t = 0;
        return () => (t += 1);
      })();
      const result = await runBenchmark(
        "defaults",
        () => {
          runs += 1;
        },
        { iterations: 0, warmup: -1, now },
      );
      // default iterations=100 + default warmup=10.
      expect(runs).toBe(110);
      expect(result.iterations).toBe(100);
      expect(result.group).toBe("");
    });

    it("awaits an async fn", async () => {
      let done = false;
      const now = (() => {
        let t = 0;
        return () => (t += 1);
      })();
      await runBenchmark(
        "async",
        async () => {
          await Promise.resolve();
          done = true;
        },
        { iterations: 1, warmup: 0, now },
      );
      expect(done).toBe(true);
    });
  });

  describe("roundMetric", () => {
    it("rounds to four decimal places", () => {
      expect(roundMetric(0.0066123)).toBe(0.0066);
      expect(roundMetric(152516.60984)).toBe(152516.6098);
    });
  });

  describe("compareToBaseline", () => {
    const baseline = {
      results: [
        { name: "fast", status: "ok", meanMs: 10 },
        { name: "zero", status: "ok", meanMs: 0 },
        { name: "was_unavailable", status: "unavailable" },
      ],
    };

    it("flags a case that regressed beyond the tolerance", () => {
      const [entry] = compareToBaseline([{ name: "fast", status: "ok", meanMs: 14 }], baseline, { tolerance: 0.25 });
      expect(entry).toMatchObject({ name: "fast", baseline: 10, current: 14, regressed: true });
      expect(entry?.deltaPct).toBeCloseTo(0.4, 5);
    });

    it("does not flag a case within tolerance (default 25%)", () => {
      const [entry] = compareToBaseline([{ name: "fast", status: "ok", meanMs: 11 }], baseline);
      expect(entry?.regressed).toBe(false);
    });

    it("treats a zero-mean baseline as a 0% delta", () => {
      const [entry] = compareToBaseline([{ name: "zero", status: "ok", meanMs: 5 }], baseline);
      expect(entry).toMatchObject({ deltaPct: 0, regressed: false });
    });

    it("never flags a non-ok current, a missing baseline, or a non-ok baseline", () => {
      const comparisons = compareToBaseline(
        [
          { name: "fast", status: "unavailable" },
          { name: "brand_new", status: "ok", meanMs: 3 },
          { name: "was_unavailable", status: "ok", meanMs: 3 },
        ],
        baseline,
      );
      expect(comparisons.every((entry) => entry.regressed === false)).toBe(true);
      expect(comparisons[0]).toMatchObject({ current: null, baseline: 10, deltaPct: null });
      expect(comparisons[1]).toMatchObject({ current: 3, baseline: null, deltaPct: null });
      expect(comparisons[2]).toMatchObject({ baseline: null, deltaPct: null });
    });

    it("tolerates a null/empty baseline document", () => {
      expect(compareToBaseline([{ name: "x", status: "ok", meanMs: 1 }], null)).toEqual([
        { name: "x", baseline: null, current: 1, deltaPct: null, regressed: false },
      ]);
    });
  });

  describe("findUncheckableCases", () => {
    const baseline = {
      results: [
        { name: "ok_case", status: "ok", meanMs: 10 },
        { name: "stale_unavailable", status: "unavailable", reason: "no node:sqlite" },
      ],
    };

    it("flags a case whose committed baseline is non-ok even when it ran ok now", () => {
      const uncheckable = findUncheckableCases(
        [
          { name: "ok_case", status: "ok", meanMs: 9 },
          { name: "stale_unavailable", status: "ok", meanMs: 3 },
        ],
        baseline,
      );
      expect(uncheckable).toEqual([
        { name: "stale_unavailable", reason: "baseline is unavailable (no node:sqlite)" },
      ]);
    });

    it("flags a case that did not run ok in the current run", () => {
      const uncheckable = findUncheckableCases(
        [{ name: "ok_case", status: "unavailable", reason: "no node:sqlite" }],
        baseline,
      );
      expect(uncheckable).toEqual([
        { name: "ok_case", reason: "current run is unavailable (no node:sqlite)" },
      ]);
    });

    it("omits the reason detail when a non-ok status carries no reason", () => {
      const uncheckable = findUncheckableCases([{ name: "ok_case", status: "errored" }], baseline);
      expect(uncheckable).toEqual([{ name: "ok_case", reason: "current run is errored" }]);
    });

    it("does not flag a brand-new case that ran ok but is absent from the baseline", () => {
      expect(findUncheckableCases([{ name: "brand_new", status: "ok", meanMs: 1 }], baseline)).toEqual([]);
    });

    it("does not flag a case that is ok in both the run and the baseline", () => {
      expect(findUncheckableCases([{ name: "ok_case", status: "ok", meanMs: 10 }], baseline)).toEqual([]);
    });

    it("tolerates a null/empty baseline document (new cases are not uncheckable)", () => {
      expect(findUncheckableCases([{ name: "ok_case", status: "ok", meanMs: 1 }], null)).toEqual([]);
    });
  });

  describe("formatBenchmarkReport", () => {
    it("renders ok cases with numbers and non-ok cases with status/reason", () => {
      const report = formatBenchmarkReport([
        { name: "a", status: "ok", meanMs: 0.5, medianMs: 0.4, opsPerSec: 2000, iterations: 100 },
        { name: "b", status: "unavailable", reason: "no node:sqlite" },
        { name: "c", status: "errored" },
      ]);
      expect(report).toContain("a");
      expect(report).toContain("ms mean");
      expect(report).toContain("b");
      expect(report).toContain("unavailable: no node:sqlite");
      expect(report).toContain("c");
      expect(report).toContain("errored");
    });
  });

  describe("renderBaselineDocument", () => {
    it("rounds ok results, preserves non-ok status/reason, and records provenance metadata", () => {
      const doc = JSON.parse(
        renderBaselineDocument(
          [
            {
              name: "a",
              group: "discovery-fanout",
              status: "ok",
              iterations: 200,
              meanMs: 0.006612,
              medianMs: 0.0057,
              minMs: 0.0041,
              maxMs: 0.1329,
              opsPerSec: 152516.6098,
            },
            { name: "b", group: "local-store", status: "unavailable", reason: "no node:sqlite" },
            { name: "c", status: "errored" },
          ],
          { nodeVersion: "v22.13.0", generatedAt: "2026-01-01T00:00:00.000Z" },
        ),
      );
      expect(doc.nodeVersion).toBe("v22.13.0");
      expect(doc.generatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(doc.note).toContain("#4845");
      expect(doc.results[0]).toMatchObject({ name: "a", status: "ok", meanMs: 0.0066 });
      expect(doc.results[1]).toMatchObject({ name: "b", status: "unavailable", reason: "no node:sqlite" });
      expect(doc.results[2]).toMatchObject({ name: "c", group: "", status: "errored", reason: null });
    });

    it("defaults provenance metadata to null when omitted", () => {
      const doc = JSON.parse(renderBaselineDocument([]));
      expect(doc.nodeVersion).toBeNull();
      expect(doc.generatedAt).toBeNull();
      expect(doc.results).toEqual([]);
    });
  });
});
