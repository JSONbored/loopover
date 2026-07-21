// #6745: the CLI mirror for loopover_list_notifications / loopover_mark_notifications_read. The MCP tools and the
// new GET /notifications + POST /notifications/read routes serve a contributor's notification feed; only the
// stdio/CLI surface was missing. These pin: `notifications --json` stays byte-identical to the route, the
// plain-text path lists the feed, `notifications-read` forwards --id (or marks all), and login resolution matches
// the sibling contributor commands.
//
// #7761: the CLI mirror above already existed, but loopover_list_notifications itself was never registered as a
// local STDIO tool (an agent on the stdio server had to shell out to the CLI to reach it). The first describe
// block below pins that proxy, same shape as the sibling loginShape tools' own stdio-proxy suites
// (mcp-cli-pr-outcomes.test.ts, mcp-cli-monitor-open-prs.test.ts): registration, the one apiGet call, and
// tool/CLI mirror parity for the same login.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Any CLI command that calls the API must go through runAsync: the fixture server lives in this process,
// so run()'s execFileSync would block the event loop and the child's fetch would abort before a response.
import { closeFixtureServer, notificationsFixture, notificationsReadFixture, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let apiUrl: string;
let markReadBodies: unknown[];

async function connect() {
  markReadBodies = [];
  apiUrl = await startFixtureServer({ onMarkNotificationsRead: (body) => markReadBodies.push(body) });
}

async function disconnect() {
  await closeFixtureServer();
}

describe("loopover_list_notifications stdio proxy (#7761)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let configDir: string;
  let capturedRequests: Array<{ url: string; method: string }>;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-list-notifications-"));
    capturedRequests = [];
    apiUrl = await startFixtureServer({
      onApiRequest: (request) => {
        if (request.url && request.url.includes("/notifications") && !request.url.includes("/notifications/read")) {
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
    client = new Client({ name: "list-notifications-test", version: "0.0.1" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await closeFixtureServer();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_list_notifications");
  });

  it("proxies login to GET /v1/contributors/:login/notifications via the same apiGet the CLI uses", async () => {
    const result = await client.callTool({ name: "loopover_list_notifications", arguments: { login: "JSONbored" } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/contributors/JSONbored/notifications");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("1 unread");
    expect(text).toContain("JSONbored/loopover#42");
  });

  it("--json emits exactly the payload the MCP tool surfaces for the same login (mirror parity)", async () => {
    const viaTool = await client.callTool({ name: "loopover_list_notifications", arguments: { login: "JSONbored" } });
    const toolData = (viaTool as { structuredContent?: unknown }).structuredContent;
    const viaCli = JSON.parse(
      await runAsync(["notifications", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" }),
    );
    expect(viaCli).toEqual(notificationsFixture());
    if (toolData !== undefined) expect(viaCli).toEqual(toolData);
  });
});

describe("loopover-mcp notifications CLI", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly the feed the route returns", async () => {
    const out = await runAsync(["notifications", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(JSON.parse(out)).toEqual(notificationsFixture());
  });

  it("prints the unread count and a line per notification", async () => {
    const out = await runAsync(["notifications", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(out).toContain("LoopOver notifications for JSONbored: 1 unread.");
    expect(out).toContain("JSONbored/loopover#42 Your pull request JSONbored/loopover#42 was merged.");
    expect(out).toContain("JSONbored/loopover#7 Changes requested on JSONbored/loopover#7.");
  });

  it("resolves the login from LOOPOVER_LOGIN, then GITHUB_LOGIN, like the sibling contributor commands", async () => {
    const viaLoopoverLogin = await runAsync(["notifications", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "JSONbored" });
    expect(JSON.parse(viaLoopoverLogin)).toEqual(notificationsFixture());
    const viaGithubLogin = await runAsync(["notifications", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", GITHUB_LOGIN: "JSONbored" });
    expect(JSON.parse(viaGithubLogin)).toEqual(notificationsFixture());
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["notifications"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login <github-login>/);
  });

  // #6261: the API chooses the notification title text, so a hostile string must not repaint the terminal.
  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    await closeFixtureServer();
    const esc = String.fromCharCode(27);
    const hostileTitle = `${esc}[31mFAKE MERGE${esc}[0m`;
    const hostileUrl = await startFixtureServer({
      notifications: {
        unreadCount: 1,
        notifications: [{ id: "x", eventType: "pull_request_merged", repoFullName: "acme/x", pullNumber: 1, title: hostileTitle, body: "b", deeplink: "https://x", status: "delivered", createdAt: "2026-06-01T00:00:00.000Z" }],
      },
    });
    const env = { LOOPOVER_API_URL: hostileUrl, LOOPOVER_TOKEN: "session-token" };

    const plain = await runAsync(["notifications", "--login", "JSONbored"], env);
    expect(plain).not.toContain(esc);
    expect(plain).toContain("FAKE MERGE");

    const asJson = await runAsync(["notifications", "--login", "JSONbored", "--json"], env);
    expect(JSON.parse(asJson).notifications[0].title).toBe(hostileTitle);
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp notifications --login <github-login> [--json]");
    expect(run(["notifications", "--help"])).toContain("Mirrors the loopover_list_notifications MCP tool");
    expect(run(["completion", "bash"])).toContain("notifications");
  });
});

describe("loopover-mcp notifications-read CLI", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly the { login, marked } the route returns", async () => {
    const out = await runAsync(["notifications-read", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(JSON.parse(out)).toEqual(notificationsReadFixture());
  });

  it("prints the marked count on the plain-text path", async () => {
    const out = await runAsync(["notifications-read", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(out).toContain("Marked 2 LoopOver notification(s) read for JSONbored.");
  });

  it("marks all (empty body) when no --id is given", async () => {
    await runAsync(["notifications-read", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(markReadBodies).toEqual([{}]);
  });

  it("forwards repeated --id flags as an ids array", async () => {
    await runAsync(["notifications-read", "--login", "JSONbored", "--id", "d-42", "--id", "d-7", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(markReadBodies).toEqual([{ ids: ["d-42", "d-7"] }]);
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["notifications-read"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login <github-login>/);
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp notifications-read --login <github-login> [--id <delivery-id>]... [--json]");
    expect(run(["notifications-read", "--help"])).toContain("Mirrors the loopover_mark_notifications_read MCP tool");
    expect(run(["completion", "bash"])).toContain("notifications-read");
  });
});
