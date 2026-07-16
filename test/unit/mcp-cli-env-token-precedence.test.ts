import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

// #6262: getEnvApiToken() resolved LOOPOVER_TOKEN ahead of LOOPOVER_MCP_TOKEN, the opposite of the order
// documented everywhere else (README, printHelp, the missing-auth error, the diagnostic sanitizer list all
// read "LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, LOOPOVER_TOKEN"). With both LOOPOVER_MCP_TOKEN and
// LOOPOVER_TOKEN set, the code picked LOOPOVER_TOKEN — so a user setting the MCP-specific token got the
// generic one instead. These tests pin the exact runtime precedence by observing which token the CLI
// actually sends as `Authorization: Bearer <token>`, so the code can never silently drift from the docs again.
describe("loopover-mcp CLI — env token precedence", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function whoamiWith(tokens: Record<string, string>) {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const url = await startFixtureServer({
      onApiRequest: (request) => requests.push({ url: request.url, authorization: request.headers.authorization }),
    });
    const whoami = JSON.parse(
      await runAsync(["whoami", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        ...tokens,
      }),
    ) as { login: string };
    const sessionRequest = requests.find((request) => request.url === "/v1/auth/session");
    return { login: whoami.login, authorization: sessionRequest?.authorization };
  }

  it("prefers LOOPOVER_API_TOKEN over LOOPOVER_MCP_TOKEN and LOOPOVER_TOKEN", async () => {
    const result = await whoamiWith({
      LOOPOVER_API_TOKEN: "session-jsonbored",
      LOOPOVER_MCP_TOKEN: "session-okto",
      LOOPOVER_TOKEN: "session-token",
    });
    expect(result.authorization).toBe("Bearer session-jsonbored");
    expect(result.login).toBe("JSONbored");
  });

  it("prefers LOOPOVER_MCP_TOKEN over LOOPOVER_TOKEN when LOOPOVER_API_TOKEN is absent", async () => {
    const result = await whoamiWith({
      LOOPOVER_MCP_TOKEN: "session-okto",
      LOOPOVER_TOKEN: "session-token",
    });
    expect(result.authorization).toBe("Bearer session-okto");
    expect(result.login).toBe("oktofeesh1");
  });

  it("falls back to LOOPOVER_TOKEN when it is the only token set", async () => {
    const result = await whoamiWith({ LOOPOVER_TOKEN: "session-token" });
    expect(result.authorization).toBe("Bearer session-token");
    expect(result.login).toBe("JSONbored");
  });
});
