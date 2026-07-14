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
    expect(result.out).toContain("bin/loopover-miner.js");
    expect(result.out).toContain("package.json");
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

  it("rejects an unexpected miner bin that matches the package name prefix", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/loopover-miner.js",
        "bin/gittensory-miner-backdoor.js",
        "lib/cli.js",
      ]),
      CHECK_MINER_PACK_TEST_CONTENT: "console.log('not secret');",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in miner package: bin/gittensory-miner-backdoor.js");
  });

  it("REGRESSION (#3704 caused main to go red, fixed by flattening lib/ instead of widening this allowlist): rejects a lib module nested one level under a subdirectory", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/loopover-miner.js",
        "lib/cli.js",
        "lib/calibration/index.js",
      ]),
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in miner package: lib/calibration/index.js");
  });

  it("rejects a file nested two levels deep under lib/", () => {
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/loopover-miner.js",
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
    expect(result.out).toContain("Miner package is missing required file: bin/loopover-miner.js");
  });

  it("rejects a package missing lib artifacts", () => {
    const result = runChecker({
      // Every REQUIRED file present so the check reaches (and fails on) the lib-artifacts guard specifically.
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify([
        "package.json",
        "bin/loopover-miner.js",
        "DEPLOYMENT.md",
        "Dockerfile",
        "schema/miner-goal-spec.schema.json",
      ]),
      CHECK_MINER_PACK_TEST_CONTENT: "{}",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Miner package is missing lib/*.js artifacts");
  });

  it("rejects secret-like content", () => {
    const probe = ["PROBE", "_", "SECRET", "=", "value"].join("");
    const result = runChecker({
      CHECK_MINER_PACK_TEST_FILES: JSON.stringify(["package.json", "bin/loopover-miner.js", "lib/cli.js"]),
      CHECK_MINER_PACK_TEST_CONTENT: probe,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in miner package file:");
  });

  describe("operational files (#4874)", () => {
    // A complete, valid package including the operational material — DEPLOYMENT.md, the Dockerfile, a docs/*.md,
    // and the schema — is accepted.
    const FULL_PACKAGE = [
      "package.json",
      "bin/loopover-miner.js",
      "lib/cli.js",
      "DEPLOYMENT.md",
      "Dockerfile",
      "docs/coding-agent-driver.md",
      "schema/miner-goal-spec.schema.json",
    ];

    it("accepts DEPLOYMENT.md, the Dockerfile, docs/*.md, and schema/*.json", () => {
      const result = runChecker({
        CHECK_MINER_PACK_TEST_FILES: JSON.stringify(FULL_PACKAGE),
        CHECK_MINER_PACK_TEST_CONTENT: "operational docs, nothing secret",
      });
      expect(result.status).toBe(0);
      expect(result.out).toMatch(/^Miner package dry-run ok:/);
      expect(result.out).toContain("DEPLOYMENT.md");
      expect(result.out).toContain("docs/coding-agent-driver.md");
      expect(result.out).toContain("schema/miner-goal-spec.schema.json");
    });

    it("requires DEPLOYMENT.md to be published (regression guard for #4874)", () => {
      const result = runChecker({
        CHECK_MINER_PACK_TEST_FILES: JSON.stringify(FULL_PACKAGE.filter((f) => f !== "DEPLOYMENT.md")),
        CHECK_MINER_PACK_TEST_CONTENT: "ok",
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain("Miner package is missing required file: DEPLOYMENT.md");
    });

    it("requires at least one docs/*.md file to be published", () => {
      const result = runChecker({
        CHECK_MINER_PACK_TEST_FILES: JSON.stringify(FULL_PACKAGE.filter((f) => !f.startsWith("docs/"))),
        CHECK_MINER_PACK_TEST_CONTENT: "ok",
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain("Miner package is missing docs/*.md operational documentation");
    });

    it("keeps the docs allowlist tight — a non-.md or nested docs file is still rejected", () => {
      const nonMarkdown = runChecker({
        CHECK_MINER_PACK_TEST_FILES: JSON.stringify([...FULL_PACKAGE, "docs/notes.txt"]),
        CHECK_MINER_PACK_TEST_CONTENT: "ok",
      });
      expect(nonMarkdown.status).toBe(1);
      expect(nonMarkdown.out).toContain("Unexpected file in miner package: docs/notes.txt");

      const nested = runChecker({
        CHECK_MINER_PACK_TEST_FILES: JSON.stringify([...FULL_PACKAGE, "docs/nested/guide.md"]),
        CHECK_MINER_PACK_TEST_CONTENT: "ok",
      });
      expect(nested.status).toBe(1);
      expect(nested.out).toContain("Unexpected file in miner package: docs/nested/guide.md");
    });
  });
});
