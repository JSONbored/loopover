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
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { status: string; checks: Array<{ name: string; status: string; detail: string }> };

    expect(payload.status).toMatch(/ok|warnings/);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "api_health", status: "pass" }),
        expect.objectContaining({ name: "auth", status: "pass", detail: expect.stringContaining("JSONbored") }),
        expect.objectContaining({ name: "source_upload", status: "pass" }),
        expect.objectContaining({ name: "git_metadata", status: "pass" }),
        expect.objectContaining({ name: "version", status: "pass" }),
        expect.objectContaining({ name: "api_compatibility", status: "pass" }),
      ]),
    );
  });

  it("reports a stale global install with an exact upgrade command and npx fallback", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ latestVersion: "9.9.9" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; latestVersion: string; updateAvailable: boolean; upgradeCommand: string; npxFallback: string } };

    expect(payload.package).toMatchObject({
      state: "stale",
      latestVersion: "9.9.9",
      updateAvailable: true,
      upgradeCommand: "npm install -g @jsonbored/gittensory-mcp@latest",
    });
    expect(payload.package.npxFallback).toContain("npx @jsonbored/gittensory-mcp@latest");
  });

  it("reports a current install without upgrade guidance", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ latestVersion: "0.2.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; updateAvailable: boolean; upgradeCommand?: string } };

    expect(payload.package.state).toBe("current");
    expect(payload.package.updateAvailable).toBe(false);
    expect(payload.package.upgradeCommand).toBeUndefined();
  });

  it("orders prerelease npm versions correctly (release outranks prerelease of the same core)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    // Local 0.2.0 (release) vs latest 0.2.0-rc.1 (prerelease) -> local is ahead, not stale.
    const aheadUrl = await startFixtureServer({ latestVersion: "0.2.0-rc.1" });
    const ahead = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: aheadUrl,
        GITTENSORY_NPM_REGISTRY_URL: aheadUrl,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; updateAvailable: boolean } };
    expect(ahead.package).toMatchObject({ state: "ahead", updateAvailable: false });
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    // Local 0.2.0 vs a higher-core prerelease 0.3.0-rc.1 -> stale.
    const staleUrl = await startFixtureServer({ latestVersion: "0.3.0-rc.1" });
    const stale = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: staleUrl,
        GITTENSORY_NPM_REGISTRY_URL: staleUrl,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string } };
    expect(stale.package.state).toBe("stale");
  });

  it("treats an unavailable npm registry as a warning, not a hard failure", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ npmStatus: 500 });
    const status = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; updateAvailable: boolean } };
    expect(status.package.state).toBe("unavailable");
    expect(status.package.updateAvailable).toBe(false);

    const doctor = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { status: string; checks: Array<{ name: string; status: string; remediation?: string }> };
    expect(doctor.status).not.toBe("needs_attention");
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "version", status: "warn" })]));
  });

  it("flags a stale install in doctor with upgrade remediation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ latestVersion: "1.0.0" });
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { checks: Array<{ name: string; status: string; remediation?: string }> };
    const version = payload.checks.find((check) => check.name === "version");
    expect(version).toMatchObject({ status: "warn" });
    expect(version?.remediation).toContain("npm install -g @jsonbored/gittensory-mcp@latest");
    expect(version?.remediation).toContain("npx @jsonbored/gittensory-mcp@latest");
  });

  it("reports API compatibility as unavailable when the API does not advertise a minimum version", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { apiCompatibility: { status: string } };
    expect(payload.apiCompatibility.status).toBe("unavailable");
  });

  it("flags API compatibility mismatches with upgrade guidance", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ minMcpVersion: "9.0.0" });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };
    const status = JSON.parse(await runAsync(["status", "--json"], env)) as { apiCompatibility: { status: string; minVersion: string; upgradeCommand: string } };
    expect(status.apiCompatibility).toMatchObject({
      status: "incompatible",
      minVersion: "9.0.0",
      upgradeCommand: "npm install -g @jsonbored/gittensory-mcp@latest",
    });

    const doctor = JSON.parse(await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], env)) as {
      checks: Array<{ name: string; status: string; remediation?: string }>;
    };
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api_compatibility",
          status: "fail",
          remediation: "npm install -g @jsonbored/gittensory-mcp@latest",
        }),
      ]),
    );
  });

  it("does not print configured tokens or local absolute paths in status or doctor output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ latestVersion: "9.9.9", minMcpVersion: "9.0.0" });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_NPM_REGISTRY_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };
    const statusOutput = await runAsync(["status"], env);
    const statusJsonOutput = await runAsync(["status", "--json"], env);
    const doctorOutput = await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory"], env);
    const doctorJsonOutput = await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], env);
    for (const output of [statusOutput, statusJsonOutput, doctorOutput, doctorJsonOutput]) {
      expect(output).not.toContain("session-token");
      expect(output).not.toContain(tempDir);
      expect(output).not.toMatch(/"configPath"/);
    }
    expect(statusOutput).not.toContain("session-token");
    // Sanity: upgrade guidance still surfaces in human-readable output.
    expect(statusOutput).toContain("npm install -g @jsonbored/gittensory-mcp@latest");
  });

  it("reports package status and prints the packaged changelog", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const status = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { package: { name: string; version: string; latestStatus: string }; api: { status: string }; auth: { login: string } };

    expect(status.package).toMatchObject({ name: "@jsonbored/gittensory-mcp", version: "0.2.0", latestStatus: "skipped" });
    expect(status.api.status).toBe("ok");
    expect(status.auth.login).toBe("JSONbored");

    const changelog = JSON.parse(run(["changelog", "--json"])) as { package: { version: string }; changelog: string };
    expect(changelog.package.version).toBe("0.2.0");
    expect(changelog.changelog).toContain("# Changelog");
  });

  it("runs base-agent CLI commands against API fixtures", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    const plan = JSON.parse(await runAsync(["agent", "plan", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], env)) as {
      run: { id: string; status: string };
      actions: Array<{ actionType: string }>;
    };
    expect(plan.run).toMatchObject({ id: "run-1", status: "completed" });
    expect(plan.actions[0]).toMatchObject({ actionType: "choose_next_work" });

    const statusPayload = JSON.parse(await runAsync(["agent", "status", "run-1", "--json"], env)) as { run: { id: string } };
    expect(statusPayload.run.id).toBe("run-1");

    const explain = JSON.parse(await runAsync(["agent", "explain", "run-1", "--json"], env)) as { topAction: { actionType: string } };
    expect(explain.topAction.actionType).toBe("choose_next_work");
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

async function startFixtureServer(options: { latestVersion?: string; minMcpVersion?: string; npmStatus?: number } = {}) {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url && request.url.includes("gittensory-mcp/latest")) {
      if (options.npmStatus && options.npmStatus >= 400) {
        response.statusCode = options.npmStatus;
        response.end(JSON.stringify({ error: "registry_error" }));
        return;
      }
      response.end(JSON.stringify({ version: options.latestVersion ?? "0.2.0" }));
      return;
    }
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", service: "gittensory-api", ...(options.minMcpVersion ? { minMcpVersion: options.minMcpVersion } : {}) }));
      return;
    }
    if (request.url === "/v1/auth/session" && request.headers.authorization === "Bearer session-token") {
      response.end(JSON.stringify({ status: "authenticated", login: "JSONbored", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["read:user"] }));
      return;
    }
    if (request.url === "/v1/agent/plan-next-work" && request.method === "POST") {
      response.end(JSON.stringify(agentFixture()));
      return;
    }
    if (request.url === "/v1/agent/runs/run-1" && request.method === "GET") {
      response.end(JSON.stringify(agentFixture()));
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

function agentFixture() {
  return {
    run: {
      id: "run-1",
      objective: "plan",
      actorLogin: "JSONbored",
      surface: "mcp",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {},
    },
    actions: [
      {
        id: "action-1",
        runId: "run-1",
        actionType: "choose_next_work",
        status: "recommended",
        recommendation: "Pick narrow work and run branch preflight.",
        why: ["Fixture"],
        blockedBy: [],
        publicSafeSummary: "Fixture public summary.",
        approvalRequired: true,
        safetyClass: "private",
        payload: {},
      },
    ],
    contextSnapshots: [],
    summary: "fixture",
  };
}
