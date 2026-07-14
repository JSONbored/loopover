import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("loopover-mcp CLI — validate-config", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env(options: Parameters<typeof startFixtureServer>[0] = {}) {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer(options);
    return { GITTENSORY_API_URL: url, GITTENSORY_TOKEN: "session-token", GITTENSORY_CONFIG_DIR: tempDir, GITTENSORY_API_TIMEOUT_MS: "1000" };
  }

  it("validates a manifest file via the API and prints plain or json output", async () => {
    const e = await env();
    const manifestPath = join(tempDir!, "manifest.yml");
    writeFileSync(manifestPath, "wantedPaths:\n  - src/\n", "utf8");

    const plain = await runAsync(["validate-config", "--file", manifestPath], e);
    expect(plain).toMatch(/Manifest validation: ok/);
    expect(plain).toMatch(/present=true/);

    const json = JSON.parse(await runAsync(["validate-config", "--file", manifestPath, "--json"], e)) as {
      status: string;
      present: boolean;
      normalized: { wantedPaths: string[] };
    };
    expect(json).toMatchObject({ status: "ok", present: true, normalized: { wantedPaths: ["src/"] } });
  });

  it("strips terminal control sequences from plain warning output only", async () => {
    const warning = 'Manifest gate field "gate.linkedIssue" must be one of off, advisory, block; ignoring "\u001b]52;c;QUJD\u0007BAD\u001b[31m".';
    const e = await env({ validateConfigWarnings: [warning] });
    const manifestPath = join(tempDir!, "manifest.yml");
    writeFileSync(manifestPath, `gate:
  linkedIssue: bad
`, "utf8");

    const plain = await runAsync(["validate-config", "--file", manifestPath], e);
    expect(plain).toContain('ignoring "BAD"');
    expect(plain).not.toContain("\u001b]52");
    expect(plain).not.toContain("\u0007");
    expect(plain).not.toContain("\u001b[31m");

    const json = JSON.parse(await runAsync(["validate-config", "--file", manifestPath, "--json"], e)) as { warnings: string[] };
    expect(json.warnings.join("\n")).toContain("\u001b]52;c;QUJD\u0007BAD\u001b[31m");
  });

  it("rejects missing --file and prints help", async () => {
    const e = await env();
    const help = run(["validate-config", "--help"]);
    expect(help).toMatch(/Usage: loopover-mcp validate-config/);
    expect(help).toMatch(/loopover_validate_config/);

    const manifestPath = join(tempDir!, "missing.yml");
    await expect(runAsync(["validate-config", "--file", manifestPath], e)).rejects.toThrow(/Manifest file not found/);
  });
});
