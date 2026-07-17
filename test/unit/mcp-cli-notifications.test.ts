// #6745: the CLI mirror for loopover_list_notifications / loopover_mark_notifications_read. The MCP tools and the
// new GET /notifications + POST /notifications/read routes serve a contributor's notification feed; only the
// stdio/CLI surface was missing. These pin: `notifications --json` stays byte-identical to the route, the
// plain-text path lists the feed, `notifications-read` forwards --id (or marks all), and login resolution matches
// the sibling contributor commands.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Any CLI command that calls the API must go through runAsync: the fixture server lives in this process,
// so run()'s execFileSync would block the event loop and the child's fetch would abort before a response.
import { closeFixtureServer, notificationsFixture, notificationsReadFixture, run, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

let apiUrl: string;
let markReadBodies: unknown[];

async function connect() {
  markReadBodies = [];
  apiUrl = await startFixtureServer({ onMarkNotificationsRead: (body) => markReadBodies.push(body) });
}

async function disconnect() {
  await closeFixtureServer();
}

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
