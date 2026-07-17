// #6746: the CLI mirror for loopover_watch_issues. The MCP tool and the new GET/POST/DELETE /watches routes manage
// a contributor's issue-watch subscriptions; only the stdio/CLI surface was missing. These pin: `watch --json`
// (list) stays byte-identical to the route, the plain-text path lists the watches, `watch --repo` forwards the
// subscription body (with repeated --label flags), `unwatch --repo` forwards the delete, the repo-format guard,
// and login resolution matching the sibling contributor commands.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Any CLI command that calls the API must go through runAsync: the fixture server lives in this process, so
// run()'s execFileSync would block the event loop and the child's fetch would abort before a response.
import { closeFixtureServer, run, runAsync, runExpectingFailure, startFixtureServer, watchesFixture } from "./support/mcp-cli-harness";

let apiUrl: string;
let watchBodies: unknown[];
let unwatchBodies: unknown[];

async function connect() {
  watchBodies = [];
  unwatchBodies = [];
  apiUrl = await startFixtureServer({ onWatch: (body) => watchBodies.push(body), onUnwatch: (body) => unwatchBodies.push(body) });
}

async function disconnect() {
  await closeFixtureServer();
}

describe("loopover-mcp watch CLI", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("with no --repo, --json emits exactly the watch list the route returns", async () => {
    const out = await runAsync(["watch", "--login", "JSONbored", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(JSON.parse(out)).toEqual(watchesFixture());
  });

  it("prints a count line and a line per watched repo on the plain-text path", async () => {
    const out = await runAsync(["watch", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(out).toContain("Watching 2 repo(s) for new grabbable issues.");
    expect(out).toContain("- acme/widgets [labels: bug]");
    expect(out).toContain("- acme/gadgets");
  });

  it("with --repo, POSTs the subscription and forwards repeated --label flags as a labels array", async () => {
    await runAsync(["watch", "--login", "JSONbored", "--repo", "acme/widgets", "--label", "bug", "--label", "docs", "--json"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
    });
    expect(watchBodies).toEqual([{ repoFullName: "acme/widgets", labels: ["bug", "docs"] }]);
  });

  it("with --repo and no --label, POSTs just the repoFullName", async () => {
    await runAsync(["watch", "--login", "JSONbored", "--repo", "acme/widgets", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(watchBodies).toEqual([{ repoFullName: "acme/widgets" }]);
  });

  it("rejects a --repo without an owner/name slash", () => {
    const failure = runExpectingFailure(["watch", "--login", "JSONbored", "--repo", "widgets"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --repo owner\/repo/);
  });

  it("resolves the login from LOOPOVER_LOGIN, then GITHUB_LOGIN, like the sibling contributor commands", async () => {
    const viaLoopoverLogin = await runAsync(["watch", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "JSONbored" });
    expect(JSON.parse(viaLoopoverLogin)).toEqual(watchesFixture());
    const viaGithubLogin = await runAsync(["watch", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", GITHUB_LOGIN: "JSONbored" });
    expect(JSON.parse(viaGithubLogin)).toEqual(watchesFixture());
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["watch"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login <github-login>/);
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp watch --login <github-login> [--repo owner/repo] [--label <label>]... [--json]");
    expect(run(["watch", "--help"])).toContain("Mirrors the loopover_watch_issues MCP tool");
    expect(run(["completion", "bash"])).toContain("watch");
  });
});

describe("loopover-mcp unwatch CLI", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("--json emits exactly what the DELETE route returns", async () => {
    const out = await runAsync(["unwatch", "--login", "JSONbored", "--repo", "acme/widgets", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(JSON.parse(out)).toEqual({ watching: [], changed: "unwatched acme/widgets" });
  });

  it("DELETEs the subscription, forwarding the repoFullName body", async () => {
    await runAsync(["unwatch", "--login", "JSONbored", "--repo", "acme/widgets", "--json"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(unwatchBodies).toEqual([{ repoFullName: "acme/widgets" }]);
  });

  it("prints the change and the updated count on the plain-text path", async () => {
    const out = await runAsync(["unwatch", "--login", "JSONbored", "--repo", "acme/widgets"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(out).toContain("unwatched acme/widgets — now watching 0 repo(s).");
  });

  it("requires --repo owner/repo", () => {
    const failure = runExpectingFailure(["unwatch", "--login", "JSONbored"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --repo owner\/repo/);
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["unwatch", "--repo", "acme/widgets"], { LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login <github-login>/);
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", () => {
    expect(run(["--help"])).toContain("loopover-mcp unwatch --login <github-login> --repo owner/repo [--json]");
    expect(run(["unwatch", "--help"])).toContain("Mirrors the loopover_watch_issues MCP tool");
    expect(run(["completion", "bash"])).toContain("unwatch");
  });
});
