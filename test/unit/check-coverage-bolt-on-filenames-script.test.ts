import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findCoverageBoltOnFilenames } from "../../scripts/check-coverage-bolt-on-filenames.js";

describe("check-coverage-bolt-on-filenames script", () => {
  it("flags a new *-coverage.test.ts file", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["unit/foo.test.ts", "unit/foo-coverage.test.ts"],
    });
    expect(offenders).toEqual(["unit/foo-coverage.test.ts"]);
  });

  it("flags a new *-branch-coverage.test.ts file", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["unit/bar-branch-coverage.test.ts"],
    });
    expect(offenders).toEqual(["unit/bar-branch-coverage.test.ts"]);
  });

  it("does not flag a file that merely contains 'coverage' mid-name, not as a bolt-on suffix", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["unit/coverage-report-parser.test.ts", "unit/rees-coverage-script.test.ts"],
    });
    expect(offenders).toEqual([]);
  });

  it("allowlists rees-coverage-script.test.ts (tests scripts/rees-coverage.js, real coverage tooling)", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["unit/rees-coverage-script.test.ts"],
    });
    expect(offenders).toEqual([]);
  });

  it("sorts the offenders and matches regardless of subdirectory nesting", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["integration/z-coverage.test.ts", "unit/a-branch-coverage.test.ts"],
    });
    expect(offenders).toEqual(["integration/z-coverage.test.ts", "unit/a-branch-coverage.test.ts"]);
  });

  it("passes cleanly when nothing matches the bolt-on pattern", () => {
    const offenders = findCoverageBoltOnFilenames({
      listTestFiles: () => ["unit/foo.test.ts", "unit/bar.test.ts"],
    });
    expect(offenders).toEqual([]);
  });

  // Most important regression test in this file: the real repo, post-consolidation (#8574), must have
  // zero bolt-on-named test files. If this fails, a new one has landed -- extend its module's existing
  // suite instead of weakening this check.
  it("the real repo has zero coverage bolt-on filenames (regression guard)", () => {
    const offenders = findCoverageBoltOnFilenames();
    expect(offenders).toEqual([]);
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
    const output = execFileSync("node", ["--experimental-strip-types", "scripts/check-coverage-bolt-on-filenames.ts"], {
      encoding: "utf8",
    });
    expect(output).toMatch(/Coverage bolt-on filename check ok/);
  });
});
