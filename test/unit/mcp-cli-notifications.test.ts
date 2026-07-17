import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, runAsync, runExpectingFailure, startFixtureServer } from "./support/mcp-cli-harness";

describe("loopover-mcp CLI — notifications / notifications-read (#6745)", () => {
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

  it("mirrors GET /v1/contributors/:login/notifications for an explicit --login (plain + json)", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));

    const plain = await runAsync(["notifications", "--login", "octocat"], e);
    expect(plain).toMatch(/LoopOver notifications for octocat: 1 unread\./);
    expect(plain).toMatch(/Changes requested on owner\/repo#7/);
    expect(requests.at(-1)).toBe("/v1/contributors/octocat/notifications");

    const json = JSON.parse(await runAsync(["notifications", "--login", "octocat", "--json"], e)) as { login: string; unreadCount: number };
    expect(json).toMatchObject({ login: "octocat", unreadCount: 1 });
  });

  it("resolves the login from LOOPOVER_LOGIN when --login is omitted, and url-encodes it", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));

    await runAsync(["notifications"], { ...e, LOOPOVER_LOGIN: "a b/c" });
    expect(requests.at(-1)).toBe("/v1/contributors/a%20b%2Fc/notifications");
  });

  it("errors (never issuing a request) when no login can be resolved", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));
    const failure = runExpectingFailure(["notifications"], { ...e, LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login/);
    expect(requests.filter((url) => url.includes("/notifications"))).toHaveLength(0);
  });

  it("mirrors POST /v1/contributors/:login/notifications/read, marking all read when --id is omitted", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const e = await env((request) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => requests.push({ url: request.url ?? "", body }));
    });

    const plain = await runAsync(["notifications-read", "--login", "octocat"], e);
    expect(plain).toMatch(/Marked 1 LoopOver notification\(s\) read for octocat\./);
    expect(requests.at(-1)?.url).toBe("/v1/contributors/octocat/notifications/read");
    expect(JSON.parse(requests.at(-1)?.body || "{}")).toEqual({});
  });

  it("passes repeated --id flags as the ids array, marking only those read", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const e = await env((request) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => requests.push({ url: request.url ?? "", body }));
    });

    const json = JSON.parse(await runAsync(["notifications-read", "--login", "octocat", "--id", "n1", "--id", "n2", "--json"], e)) as { login: string; marked: number };
    expect(json).toMatchObject({ login: "octocat", marked: 2 });
    expect(JSON.parse(requests.at(-1)?.body || "{}")).toEqual({ ids: ["n1", "n2"] });
  });

  it("errors (never issuing a request) when no login can be resolved", async () => {
    const requests: string[] = [];
    const e = await env((request) => requests.push(request.url ?? ""));
    const failure = runExpectingFailure(["notifications-read"], { ...e, LOOPOVER_LOGIN: "", GITHUB_LOGIN: "" });
    expect(`${failure.stdout}${failure.stderr}`).toMatch(/Pass --login/);
    expect(requests.filter((url) => url.includes("/notifications"))).toHaveLength(0);
  });
});
