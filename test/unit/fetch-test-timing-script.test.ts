import { describe, expect, it } from "vitest";
import {
  aggregateByFile,
  RETRYABLE_STATUS,
  shouldRetryCodecovFetch,
} from "../../scripts/fetch-test-timing.js";

describe("fetch-test-timing.ts (#7457)", () => {
  describe("aggregateByFile", () => {
    it("sums multiple rows for the same file within one commit before averaging across commits", () => {
      // Two test cases in commit A (2s + 3s = 5s that run), one case in commit B (1s). Average across
      // commits must be (5 + 1) / 2 = 3 — NOT the flat mean of the three rows ((2+3+1)/3 = 2), which would
      // be the "many test cases dwarf few" failure mode the function's header comment warns about.
      const averages = aggregateByFile([
        { filename: "test/unit/a.test.ts", commit_sha: "aaa", duration_seconds: 2 },
        { filename: "test/unit/a.test.ts", commit_sha: "aaa", duration_seconds: 3 },
        { filename: "test/unit/a.test.ts", commit_sha: "bbb", duration_seconds: 1 },
      ]);

      expect(averages).toEqual({ "test/unit/a.test.ts": 3 });
    });

    it("averages the same file across commits instead of summing every historical row", () => {
      // Same file in three commits at 10s each: average is 10, not 30 (the "many historical rows inflate
      // further with every pooled run" failure mode).
      const averages = aggregateByFile([
        { filename: "test/unit/b.test.ts", commit_sha: "c1", duration_seconds: 10 },
        { filename: "test/unit/b.test.ts", commit_sha: "c2", duration_seconds: 10 },
        { filename: "test/unit/b.test.ts", commit_sha: "c3", duration_seconds: 10 },
      ]);

      expect(averages).toEqual({ "test/unit/b.test.ts": 10 });
    });

    it("skips rows with a missing filename or null/undefined duration_seconds", () => {
      const averages = aggregateByFile([
        { filename: "", commit_sha: "c1", duration_seconds: 5 },
        { filename: null, commit_sha: "c1", duration_seconds: 5 },
        { filename: undefined, commit_sha: "c1", duration_seconds: 5 },
        { filename: "test/unit/c.test.ts", commit_sha: "c1", duration_seconds: null },
        { filename: "test/unit/c.test.ts", commit_sha: "c1", duration_seconds: undefined },
        { filename: "test/unit/c.test.ts", commit_sha: "c1", duration_seconds: 4 },
        { filename: "test/unit/c.test.ts", commit_sha: "c2", duration_seconds: 6 },
      ]);

      expect(averages).toEqual({ "test/unit/c.test.ts": 5 });
    });

    it("aggregates independent files without cross-contaminating their averages", () => {
      const averages = aggregateByFile([
        { filename: "test/unit/fast.test.ts", commit_sha: "c1", duration_seconds: 1 },
        { filename: "test/unit/slow.test.ts", commit_sha: "c1", duration_seconds: 2 },
        { filename: "test/unit/slow.test.ts", commit_sha: "c1", duration_seconds: 2 },
        { filename: "test/unit/slow.test.ts", commit_sha: "c2", duration_seconds: 8 },
      ]);

      expect(averages).toEqual({
        "test/unit/fast.test.ts": 1,
        "test/unit/slow.test.ts": 6, // commit c1 summed to 4, then (4 + 8) / 2
      });
    });

    it("returns an empty object for an empty input", () => {
      expect(aggregateByFile([])).toEqual({});
    });
  });

  describe("shouldRetryCodecovFetch", () => {
    it("retries the documented transient statuses while attempts remain", () => {
      for (const status of RETRYABLE_STATUS) {
        expect(shouldRetryCodecovFetch(status, 1, 4)).toBe(true);
        expect(shouldRetryCodecovFetch(status, 3, 4)).toBe(true);
      }
    });

    it("does not retry a non-retryable status or the final attempt", () => {
      expect(shouldRetryCodecovFetch(400, 1, 4)).toBe(false);
      expect(shouldRetryCodecovFetch(401, 1, 4)).toBe(false);
      expect(shouldRetryCodecovFetch(404, 1, 4)).toBe(false);
      expect(shouldRetryCodecovFetch(429, 4, 4)).toBe(false);
      expect(shouldRetryCodecovFetch(500, 4, 4)).toBe(false);
    });
  });
});
