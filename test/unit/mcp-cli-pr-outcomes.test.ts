// #6747: CLI + stdio mirrors for loopover_pr_outcome. The host MCP tool already existed; this pins the
// REST-backed stdio proxy and shell CLI against the same fixture payload.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, prOutcomesFixture, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-pr-outcomes-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/pr-outcomes")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "pr-outcomes-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_pr_outcome stdio proxy (#6747)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_pr_outcome");
  });

  it("proxies login (+ optional limit) to GET /v1/contributors/:login/pr-outcomes", async () => {
    const result = await client.callTool({ name: "loopover_pr_outcome", arguments: { login: "JSONbored", limit: 10 } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/contributors/JSONbored/pr-outcomes");
    expect(captured.url).toContain("limit=10");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("JSONbored/loopover");
    expect(text).toContain(prOutcomesFixture().summary);
  });
});

describe("loopover-mcp pr-outcomes CLI (#6747)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly the payload the MCP tool surfaces for the same login (mirror parity)", async () => {
    const viaTool = await client.callTool({ name: "loopover_pr_outcome", arguments: { login: "JSONbored" } });
    const toolData = (viaTool as { structuredContent?: unknown }).structuredContent;
    const viaCli = JSON.parse(
      await runAsync(["pr-outcomes", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" }),
    );
    expect(viaCli).toEqual(prOutcomesFixture());
    if (toolData !== undefined) expect(viaCli).toEqual(toolData);
  });

  it("prints the API summary and one line per outcome", async () => {
    const out = await runAsync(["pr-outcomes", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    const fixture = prOutcomesFixture();
    expect(out).toContain(fixture.summary);
    expect(out).toContain("JSONbored/loopover#42 [merged]");
    expect(out).toContain(fixture.outcomes[0]!.attribution);
  });

  it("forwards --limit and resolves login from LOOPOVER_LOGIN / GITHUB_LOGIN", async () => {
    await runAsync(["pr-outcomes", "--json", "--limit", "5"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "JSONbored",
    });
    expect(capturedRequests.at(-1)?.url).toContain("limit=5");

    const viaGithubLogin = await runAsync(["pr-outcomes", "--json"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      GITHUB_LOGIN: "JSONbored",
    });
    expect(JSON.parse(viaGithubLogin)).toEqual(prOutcomesFixture());
  });

  it("fails when no login is resolvable or --limit is out of range", () => {
    const noLogin = runExpectingFailure(["pr-outcomes"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "",
      GITHUB_LOGIN: "",
    });
    expect(noLogin.status).toBe(1);
    expect(`${noLogin.stdout}${noLogin.stderr}`).toMatch(/Pass --login <github-login> or set LOOPOVER_LOGIN\./);

    const badLimit = runExpectingFailure(["pr-outcomes", "--login", "JSONbored", "--limit", "0"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(badLimit.status).toBe(1);
    expect(`${badLimit.stdout}${badLimit.stderr}`).toMatch(/integer between 1 and 100/);

    const bareLimit = runExpectingFailure(["pr-outcomes", "--login", "JSONbored", "--limit", "101"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(bareLimit.status).toBe(1);
  });

  it("falls back when the API omits summary and prints null pull numbers / empty attributions", async () => {
    await closeFixtureServer();
    const sparseUrl = await startFixtureServer({
      prOutcomes: {
        summary: "   ",
        outcomes: [{ repoFullName: "a/b", pullNumber: null, outcome: "merged", attribution: "", deeplink: "https://x", recordedAt: "t" }],
      },
    });
    const env = { LOOPOVER_API_URL: sparseUrl, LOOPOVER_TOKEN: "session-token" };
    const plain = await runAsync(["pr-outcomes", "--login", "JSONbored"], env);
    expect(plain).toContain("LoopOver post-merge outcomes for JSONbored.");
    expect(plain).toContain("a/b#? [merged]");
  });

  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    await closeFixtureServer();
    const hostileUrl = await startFixtureServer({
      prOutcomes: { summary: "\u001b[31mFAKE PASS\u001b[0m", outcomes: [{ repoFullName: "a/b", pullNumber: 1, outcome: "merged", attribution: "\u001b[2Krewritten", deeplink: "https://x", recordedAt: "t" }] },
    });
    const env = { LOOPOVER_API_URL: hostileUrl, LOOPOVER_TOKEN: "session-token" };

    const plain = await runAsync(["pr-outcomes", "--login", "JSONbored"], env);
    expect(plain).not.toContain("\u001b");
    expect(plain).toContain("FAKE PASS");
    expect(plain).toContain("rewritten");

    const asJson = await runAsync(["pr-outcomes", "--login", "JSONbored", "--json"], env);
    expect(JSON.parse(asJson).summary).toBe("\u001b[31mFAKE PASS\u001b[0m");
  });

  it("ignores a bare --limit flag (no value) and still returns outcomes", async () => {
    const out = await runAsync(["pr-outcomes", "--login", "JSONbored", "--limit", "--json"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(JSON.parse(out)).toEqual(prOutcomesFixture());
    expect(capturedRequests.at(-1)?.url).not.toContain("limit=");
  });

  it("documents itself in --help and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp pr-outcomes --login <github-login> [--limit N] [--json]");
    expect(run(["pr-outcomes", "--help"])).toContain("Mirrors the loopover_pr_outcome MCP tool");
    expect(run(["completion", "bash"])).toContain("pr-outcomes");
  });
});
