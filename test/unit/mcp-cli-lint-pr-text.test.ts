import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — lint-pr-text", () => {
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

  it("lints commit + body via the API and prints plain or json output", async () => {
    const e = await env();
    const plain = await runAsync(
      [
        "lint-pr-text",
        "--commit",
        "feat(mcp): add lint-pr-text cli",
        "--body",
        "Adds a shell wrapper for POST /v1/lint/pr-text. Validated with npm run test:ci.",
        "--linked-issue",
        "160",
      ],
      e,
    );
    expect(plain).toMatch(/PR text lint: strong \(score 100\)/);
    expect(plain).toMatch(/Fixture PR-text lint verdict: strong/);

    const json = JSON.parse(
      await runAsync(
        [
          "lint-pr-text",
          "--commit",
          "feat(mcp): add lint-pr-text cli",
          "--body",
          "Adds a shell wrapper for POST /v1/lint/pr-text.",
          "--linked-issue",
          "160",
          "--json",
        ],
        e,
      ),
    ) as { verdict: string; score: number; fixes: string[] };
    expect(json).toMatchObject({ verdict: "strong", score: 100, fixes: [] });
    expect(JSON.stringify(json)).not.toMatch(/wallet|hotkey|reward|trust score/i);
  });

  it("reads PR bodies from --body-file and supports repeated --commit flags", async () => {
    const e = await env();
    const bodyPath = join(tempDir!, "pr-body.md");
    writeFileSync(bodyPath, "Fixes #7\n\nValidated with npm test.", "utf8");
    const json = JSON.parse(
      await runAsync(
        ["lint-pr-text", "--commit", "fix(api): handle reconnect", "--commit", "chore: follow-up", "--body-file", bodyPath, "--linked-issue", "7", "--json"],
        e,
      ),
    ) as { verdict: string; components: Array<{ key: string }> };
    expect(json.verdict).toBe("strong");
    expect(json.components[0]).toMatchObject({ key: "traceability" });
  });

  it("rejects non-regular and oversized --body-file inputs before posting", async () => {
    const e = await env();
    const directoryPath = join(tempDir!, "body-dir");
    mkdirSync(directoryPath);
    await expect(runAsync(["lint-pr-text", "--body-file", directoryPath], e)).rejects.toThrow(/Body file must be a regular file/);

    const targetPath = join(tempDir!, "target.md");
    const symlinkPath = join(tempDir!, "symlink.md");
    writeFileSync(targetPath, "Fixes #7", "utf8");
    symlinkSync(targetPath, symlinkPath);
    await expect(runAsync(["lint-pr-text", "--body-file", symlinkPath], e)).rejects.toThrow(/Body file must be a regular file/);

    const oversizedPath = join(tempDir!, "oversized.md");
    writeFileSync(oversizedPath, "x".repeat(1024 * 1024 + 1), "utf8");
    await expect(runAsync(["lint-pr-text", "--body-file", oversizedPath], e)).rejects.toThrow(/Body file is too large/);
  });

  it("surfaces weak verdicts and actionable fixes in plain output", async () => {
    const e = await env();
    const out = await runAsync(["lint-pr-text", "--commit", "wip", "--json"], e);
    const json = JSON.parse(out) as { verdict: string; fixes: string[] };
    expect(json.verdict).toBe("weak");
    const plain = await runAsync(["lint-pr-text", "--commit", "wip"], e);
    expect(plain).toMatch(/PR text lint: weak/);
    expect(plain).toMatch(/Conventional Commit subject/);
  });

  it("validates inputs and prints help", async () => {
    const e = await env();
    await expect(runAsync(["lint-pr-text", "--linked-issue", "0"], e)).rejects.toThrow(/positive integer/);
    await expect(runAsync(["lint-pr-text", "--body-file", "/tmp/missing-gittensory-pr-body.md"], e)).rejects.toThrow(/Body file not found/);
    const help = run(["lint-pr-text", "--help"]);
    expect(help).toMatch(/Usage: gittensory-mcp lint-pr-text/);
    expect(help).toMatch(/gittensory_lint_pr_text/);
    expect(help).toMatch(/--body-file/);
  });

  it("suggests lint-pr-text for close typos", () => {
    expect(() => run(["lint-pr-txt"])).toThrow(/Did you mean `lint-pr-text`\?/);
  });
});
