// #6732: the CLI mirror for loopover_monitor_open_prs. The MCP tool and GET
// /v1/contributors/:login/open-pr-monitor already served this; only the stdio/CLI surface was missing.
// These pin the three things that can silently rot: the tool is registered, both surfaces hit the same
// route, and `monitor-open-prs --json` stays byte-identical to what the tool returns for one input.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Any CLI command that calls the API must go through runAsync: the fixture server lives in this process,
// so run()'s execFileSync would block the event loop and the child's fetch would abort before a response.
import { closeFixtureServer, openPrMonitorFixture, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-monitor-open-prs-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/open-pr-monitor")) {
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
  client = new Client({ name: "monitor-open-prs-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_monitor_open_prs stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_monitor_open_prs");
  });

  it("proxies login to /v1/contributors/:login/open-pr-monitor via apiGet and returns the monitor", async () => {
    const result = await client.callTool({ name: "loopover_monitor_open_prs", arguments: { login: "JSONbored" } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/contributors/JSONbored/open-pr-monitor");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("JSONbored/gittensory");
    expect(text).toContain("failing_checks");
    // The tool summary is the API's own sentence, not a second one invented client-side.
    expect(text).toContain(openPrMonitorFixture().summary);
  });
});

describe("loopover-mcp monitor-open-prs CLI", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly the payload the MCP tool surfaces for the same login (mirror parity)", async () => {
    const viaTool = await client.callTool({ name: "loopover_monitor_open_prs", arguments: { login: "JSONbored" } });
    const toolData = (viaTool as { structuredContent?: unknown }).structuredContent;
    const viaCli = JSON.parse(await runAsync(["monitor-open-prs", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" }));
    expect(viaCli).toEqual(openPrMonitorFixture());
    if (toolData !== undefined) expect(viaCli).toEqual(toolData);
  });

  it("prints the API summary, guidance, and a next-step line per open PR", async () => {
    const out = await runAsync(["monitor-open-prs", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    const fixture = openPrMonitorFixture();
    expect(out).toContain(fixture.summary);
    expect(out).toContain(fixture.guidance[0]!);
    expect(out).toContain("JSONbored/gittensory#42 [failing_checks] fix(queue): drain stale entries");
    expect(out).toContain("  - Fix the failing check, then push.");
  });

  it("resolves the login from LOOPOVER_LOGIN, then GITHUB_LOGIN, the way decision-pack does", async () => {
    const viaLoopoverLogin = await runAsync(["monitor-open-prs", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "JSONbored" });
    expect(JSON.parse(viaLoopoverLogin)).toEqual(openPrMonitorFixture());
    const viaGithubLogin = await runAsync(["monitor-open-prs", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", GITHUB_LOGIN: "JSONbored" });
    expect(JSON.parse(viaGithubLogin)).toEqual(openPrMonitorFixture());
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["monitor-open-prs"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login <github-login> or set LOOPOVER_LOGIN\./);
  });

  // #6261: the API composes the summary/guidance and echoes PR titles back from third-party repos, so a hostile
  // string must not be able to repaint the terminal. --json stays raw on purpose: JSON.stringify escapes U+001B.
  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    await closeFixtureServer();
    const hostileUrl = await startFixtureServer({ openPrMonitor: { summary: "[31mFAKE PASS[0m", guidance: ["[2Krewritten"] } });
    const env = { LOOPOVER_API_URL: hostileUrl, LOOPOVER_TOKEN: "session-token" };

    const plain = await runAsync(["monitor-open-prs", "--login", "JSONbored"], env);
    expect(plain).not.toContain("");
    expect(plain).toContain("FAKE PASS");
    expect(plain).toContain("rewritten");

    const asJson = await runAsync(["monitor-open-prs", "--login", "JSONbored", "--json"], env);
    expect(JSON.parse(asJson).summary).toBe("[31mFAKE PASS[0m");
  });

  it("documents itself in --help and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp monitor-open-prs --login <github-login> [--json]");
    expect(run(["monitor-open-prs", "--help"])).toContain("Mirrors the loopover_monitor_open_prs MCP tool");
    expect(run(["completion", "bash"])).toContain("monitor-open-prs");
  });
});
