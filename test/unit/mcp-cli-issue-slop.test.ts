import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — issue-slop", () => {
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

  it("assesses issue slop via the API and prints plain or json output", async () => {
    const e = await env();
    const plain = await runAsync(
      [
        "issue-slop",
        "--title",
        "Add retry handling for widget reconnects",
        "--body",
        "The widget client drops transient failures without retrying. Add bounded retries with jitter and cover the reconnect path in unit tests.",
      ],
      e,
    );
    expect(plain).toMatch(/Issue slop risk: 0 \(clean\)/);

    const json = JSON.parse(
      await runAsync(
        [
          "issue-slop",
          "--title",
          "Add retry handling for widget reconnects",
          "--body",
          "The widget client drops transient failures without retrying.",
          "--json",
        ],
        e,
      ),
    ) as { slopRisk: number; band: string; findings: unknown[]; rubric: string };
    expect(json).toMatchObject({ slopRisk: 0, band: "clean", findings: [], rubric: expect.any(String) });
    expect(JSON.stringify(json)).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  it("reads issue bodies from --body-file", async () => {
    const e = await env();
    const bodyPath = join(tempDir!, "issue-body.md");
    writeFileSync(bodyPath, "Retry widget reconnects with bounded backoff and add unit coverage.", "utf8");
    const json = JSON.parse(await runAsync(["issue-slop", "--title", "Improve widget reconnects", "--body-file", bodyPath, "--json"], e)) as {
      band: string;
    };
    expect(json.band).toBe("clean");
  });

  it("rejects non-regular and oversized --body-file inputs before posting", async () => {
    const e = await env();
    const directoryPath = join(tempDir!, "body-dir");
    mkdirSync(directoryPath);
    await expect(runAsync(["issue-slop", "--title", "Add retries", "--body-file", directoryPath], e)).rejects.toThrow(/Body file must be a regular file/);

    const targetPath = join(tempDir!, "target.md");
    const symlinkPath = join(tempDir!, "symlink.md");
    writeFileSync(targetPath, "Retry widget reconnects.", "utf8");
    symlinkSync(targetPath, symlinkPath);
    await expect(runAsync(["issue-slop", "--title", "Add retries", "--body-file", symlinkPath], e)).rejects.toThrow(/Body file must be a regular file/);

    const oversizedPath = join(tempDir!, "oversized.md");
    writeFileSync(oversizedPath, "x".repeat(1024 * 1024 + 1), "utf8");
    await expect(runAsync(["issue-slop", "--title", "Add retries", "--body-file", oversizedPath], e)).rejects.toThrow(/Body file is too large/);
  });

  it("surfaces elevated issue slop findings in plain output", async () => {
    const e = await env();
    const json = JSON.parse(await runAsync(["issue-slop", "--title", "Add retries", "--body", "", "--json"], e)) as {
      slopRisk: number;
      band: string;
      findings: Array<{ title: string }>;
    };
    expect(json).toMatchObject({ slopRisk: 30, band: "elevated" });
    const plain = await runAsync(["issue-slop", "--title", "Add retries", "--body", ""], e);
    expect(plain).toMatch(/Issue slop risk: 30 \(elevated\)/);
    expect(plain).toMatch(/Issue has no description/);
  });

  it("validates inputs and prints help", async () => {
    const e = await env();
    await expect(runAsync(["issue-slop", "--body-file", "/tmp/missing-gittensory-issue-body.md"], e)).rejects.toThrow(/Body file not found/);
    const help = run(["issue-slop", "--help"]);
    expect(help).toMatch(/Usage: gittensory-mcp issue-slop/);
    expect(help).toMatch(/gittensory_check_issue_slop/);
    expect(help).toMatch(/--body-file/);
  });

  it("suggests issue-slop for close typos", () => {
    expect(() => run(["issue-slopx"])).toThrow(/Did you mean `issue-slop`\?/);
  });
});
