import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runChecker(env: Record<string, string | undefined> = {}): { status: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-miner-package.mjs"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check-miner-package script", () => {
  it("passes on the real miner workspace package", () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^Miner package dry-run ok:/);
    expect(result.out).toContain("bin/gittensory-miner.js");
    expect(result.out).toContain("package.json");
  });

  it("allows nested lib subdirectories such as calibration/", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/gittensory-miner.js",
        "lib/calibration/index.js",
        "lib/calibration/types.d.ts",
      ]),
    });
    expect(result.status).toBe(0);
  });

  it("rejects a forbidden path", () => {
    const result = runChecker({ CHECK_MINER_PACK_TEST_FILES: JSON.stringify([".env"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Forbidden file in miner package: .env");
  });

  it("rejects an unexpected file", () => {
    const result = runChecker({ CHECK_MINER_PACK_TEST_FILES: JSON.stringify(["scripts/extra.mjs"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in miner package: scripts/extra.mjs");
  });

  it("REGRESSION (main was red after #3704): accepts a lib module split into a one-level subdirectory", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/gittensory-miner.js",
        "lib/calibration/index.js",
        "lib/calibration/index.d.ts",
      ]),
      CHECK_MINER_PACK_TEST_CONTENT: "{}",
    });
    expect(result.status).toBe(0);
    expect(result.out).toContain("lib/calibration/index.js");
  });

  it("still rejects a file nested two levels deep under lib/", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/gittensory-miner.js",
        "lib/cli.js",
        "lib/calibration/nested/index.js",
      ]),
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in miner package: lib/calibration/nested/index.js");
  });

  it("rejects a package missing the CLI bin", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify(["package.json", "lib/cli.js"]),
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Miner package is missing required file: bin/gittensory-miner.js");
  });

  it("rejects a package missing lib artifacts", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify(["package.json", "bin/gittensory-miner.js"]),
      CHECK_MINER_PACK_TEST_CONTENT: "{}",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Miner package is missing lib/*.js artifacts");
  });

  it("rejects secret-like content", () => {
    const probe = ["PROBE", "_", "SECRET", "=", "value"].join("");
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify(["package.json", "bin/gittensory-miner.js", "lib/cli.js"]),
      CHECK_MINER_PACK_TEST_CONTENT: probe,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in miner package file:");
  });
});
