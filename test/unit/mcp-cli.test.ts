import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");
let server: Server | null = null;

describe("gittensory-mcp CLI", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("prints MCP client snippets without mutating client config", () => {
    const codex = run(["init-client", "--print", "codex"]);
    expect(codex).toContain("[mcp_servers.gittensory]");
    expect(codex).toContain('args = ["--stdio"]');

    const claude = JSON.parse(run(["init-client", "--print", "claude", "--json"])) as { snippet: string };
    expect(claude.snippet).toContain('"mcpServers"');
    expect(claude.snippet).toContain('"gittensory"');
  });

  it("runs doctor against a local health/session fixture", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { status: string; checks: Array<{ name: string; status: string; detail: string }> };

    expect(payload.status).toMatch(/ok|warnings/);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "api_health", status: "pass" }),
        expect.objectContaining({ name: "auth", status: "pass", detail: expect.stringContaining("JSONbored") }),
        expect.objectContaining({ name: "source_upload", status: "pass" }),
        expect.objectContaining({ name: "git_metadata", status: "pass" }),
      ]),
    );
  });

  it("rejects unsupported client snippets", () => {
    expect(() => run(["init-client", "--print", "other"])).toThrow(/Unsupported client/);
  });
});

function run(args: string[], env: Record<string, string> = {}) {
  return execFileSync("node", [bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITTENSORY_API_TIMEOUT_MS: "1000",
      GITTENSORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "gittensory-cli-config-")),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runAsync(args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "node",
      [bin, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITTENSORY_API_TIMEOUT_MS: "1000",
          GITTENSORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "gittensory-cli-config-")),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function startFixtureServer() {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", service: "gittensory-api" }));
      return;
    }
    if (request.url === "/v1/auth/session" && request.headers.authorization === "Bearer session-token") {
      response.end(JSON.stringify({ status: "authenticated", login: "JSONbored", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}
