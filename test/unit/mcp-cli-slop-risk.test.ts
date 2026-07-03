import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — slop-risk", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env() {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    return { GITTENSORY_API_URL: url, GITTENSORY_TOKEN: "session-token", GITTENSORY_CONFIG_DIR: tempDir, GITTENSORY_API_TIMEOUT_MS: "1000" };
  }

  it("assesses slop risk via the API and prints plain or json output", async () => {
    const e = await env();
    const plain = await runAsync(
      [
        "slop-risk",
        "--changed-file",
        "src/widget.ts:80:2",
        "--description",
        "Adds retry handling for transient widget failures. Validated with npm test.",
        "--test",
        "npm test",
      ],
      e,
    );
    expect(plain).toMatch(/Slop risk: 0 \(clean\)/);

    const json = JSON.parse(
      await runAsync(
        [
          "slop-risk",
          "--changed-file",
          "src/widget.ts:80:2",
          "--description",
          "Adds retry handling for transient widget failures.",
          "--test-file",
          "test/unit/widget.test.ts",
          "--json",
        ],
        e,
      ),
    ) as { slopRisk: number; band: string; findings: unknown[]; rubric: string };
    expect(json).toMatchObject({ slopRisk: 0, band: "clean", findings: [], rubric: expect.any(String) });
    expect(JSON.stringify(json)).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  it("reads descriptions from --description-file and supports repeated changed files", async () => {
    const e = await env();
    const descriptionPath = join(tempDir!, "description.md");
    writeFileSync(descriptionPath, "Fixes #7 with focused retry handling.", "utf8");
    const json = JSON.parse(
      await runAsync(
        [
          "slop-risk",
          "--changed-file",
          "src/widget.ts:12:1",
          "--changed-file",
          "test/unit/widget.test.ts:40:0",
          "--description-file",
          descriptionPath,
          "--json",
        ],
        e,
      ),
    ) as { band: string };
    expect(json.band).toBe("clean");
  });

  it("surfaces elevated slop findings in plain output", async () => {
    const e = await env();
    const json = JSON.parse(await runAsync(["slop-risk", "--changed-file", "src/widget.ts:80:2", "--json"], e)) as {
      slopRisk: number;
      band: string;
      findings: Array<{ title: string }>;
    };
    expect(json).toMatchObject({ slopRisk: 45, band: "elevated" });
    const plain = await runAsync(["slop-risk", "--changed-file", "src/widget.ts:80:2"], e);
    expect(plain).toMatch(/Slop risk: 45 \(elevated\)/);
    expect(plain).toMatch(/Empty PR description/);
  });

  it("validates inputs and prints help", async () => {
    const e = await env();
    await expect(runAsync(["slop-risk", "--changed-file", ":1:2"], e)).rejects.toThrow(/Invalid --changed-file/);
    await expect(runAsync(["slop-risk", "--changed-file", "src/a.ts:-1"], e)).rejects.toThrow(/Invalid additions/);
    await expect(runAsync(["slop-risk", "--description-file", "/tmp/missing-gittensory-slop-description.md"], e)).rejects.toThrow(/Description file not found/);
    const help = run(["slop-risk", "--help"]);
    expect(help).toMatch(/Usage: gittensory-mcp slop-risk/);
    expect(help).toMatch(/gittensory_check_slop_risk/);
    expect(help).toMatch(/--changed-file/);
  });

  it("suggests slop-risk for close typos", () => {
    expect(() => run(["slop-rsk"])).toThrow(/Did you mean `slop-risk`\?/);
  });
});
