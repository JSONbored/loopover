import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

describe("loopover-mcp CLI — contributor-profile (#6737)", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env(onApiRequest?: (request: import("node:http").IncomingMessage) => void) {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer(onApiRequest ? { onApiRequest } : {});
    return { LOOPOVER_API_URL: url, LOOPOVER_TOKEN: "session-token", LOOPOVER_CONFIG_DIR: tempDir, LOOPOVER_API_TIMEOUT_MS: "1000" };
  }

  it("mirrors GET /v1/contributors/:login/profile for an explicit --login (plain + json)", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));

    const plain = await runAsync(["contributor-profile", "--login", "octocat"], e);
    expect(plain).toMatch(/LoopOver contributor profile for octocat\./);
    expect(requests.at(-1)).toBe("/v1/contributors/octocat/profile");

    const json = JSON.parse(await runAsync(["contributor-profile", "--login", "octocat", "--json"], e)) as { login: string; source: string };
    // Parity: the --json surface re-serializes the payload verbatim. Asserted on fields the endpoint really
    // returns -- the previous assertion named a `summary` that only ever existed in the fixture (#9773).
    expect(json).toMatchObject({ login: "octocat", source: "github_cache" });
  });

  it("resolves the login from LOOPOVER_LOGIN when --login is omitted, and url-encodes it", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));

    await runAsync(["contributor-profile"], { ...e, LOOPOVER_LOGIN: "a b/c" });
    expect(requests.at(-1)).toBe("/v1/contributors/a%20b%2Fc/profile");
  });

  it("errors (never issuing a request) when no login can be resolved", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));
    // Clear every login fallback the CLI would otherwise read from the ambient process env.
    const failure = runExpectingFailure(["contributor-profile"], { ...e, LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login/);
    expect(requests.filter((url) => url.includes("/profile"))).toHaveLength(0);
  });

  it("prints usage for --help without resolving a login or hitting the network (#6992)", () => {
    // --help must short-circuit BEFORE login resolution, so this succeeds with no --login and no server --
    // previously it fell through and threw the "Pass --login" error instead of printing usage.
    const help = run(["contributor-profile", "--help"], { LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(help).toContain("Usage: loopover-mcp contributor-profile --login <github-login> [--json]");
    expect(help).toContain("Mirrors the loopover_get_contributor_profile MCP tool");
    expect(help).not.toMatch(/Pass --login/);
  });
});
