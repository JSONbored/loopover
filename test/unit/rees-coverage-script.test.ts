import { describe, expect, it, vi } from "vitest";
import { normalizeLcovSfPaths } from "../../scripts/rees-coverage.js";

describe("rees-coverage script", () => {
  describe("normalizeLcovSfPaths", () => {
    it("swallows ENOENT when the lcov report does not exist yet", () => {
      const readFile = vi.fn(() => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });
      const writeFile = vi.fn();

      expect(() => normalizeLcovSfPaths("/tmp/missing/lcov.info", { readFile, writeFile })).not.toThrow();
      expect(readFile).toHaveBeenCalledOnce();
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("re-throws a write failure instead of masking it as a missing report", () => {
      const writeErr = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      writeErr.code = "EACCES";
      const readFile = vi.fn(() => "SF:review-enrichment\\src\\foo.ts\nend_of_record\n");
      const writeFile = vi.fn(() => {
        throw writeErr;
      });

      expect(() => normalizeLcovSfPaths("/tmp/lcov.info", { readFile, writeFile })).toThrow(writeErr);
      expect(writeFile).toHaveBeenCalledOnce();
    });

    it("normalizes backslashes in SF: paths to forward slashes", () => {
      let written = "";
      const readFile = vi.fn(() => "SF:review-enrichment\\src\\foo.ts\nend_of_record\n");
      const writeFile = vi.fn((_path: string, content: string) => {
        written = content;
      });

      normalizeLcovSfPaths("/tmp/lcov.info", { readFile, writeFile });

      expect(written).toBe("SF:review-enrichment/src/foo.ts\nend_of_record\n");
    });
  });
});
