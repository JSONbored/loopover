import { type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — profiles", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("stores, switches, and reports named MCP profiles without mixing sessions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const url = await startFixtureServer({
      onApiRequest: (request) => requests.push({ url: request.url, authorization: request.headers.authorization }),
    });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const firstLogin = JSON.parse(await runAsync(["login", "--profile", "JSONbored", "--github-token", "github-jsonbored", "--json"], env)) as { profile: string; login: string };
    const secondLogin = JSON.parse(await runAsync(["login", "--profile", "Okto", "--github-token", "github-okto", "--json"], env)) as { profile: string; login: string };
    const list = JSON.parse(await runAsync(["profile", "list", "--json"], env)) as { activeProfile: string; profiles: Array<{ name: string; login: string | null; authenticated: boolean }> };
    const firstWhoami = JSON.parse(await runAsync(["whoami", "--profile", "jsonbored", "--json"], env)) as { profile: string; login: string };
    const secondWhoami = JSON.parse(await runAsync(["whoami", "--profile", "okto", "--json"], env)) as { profile: string; login: string };
    const switched = JSON.parse(await runAsync(["profile", "switch", "jsonbored", "--json"], env)) as { activeProfile: string };
    const activeWhoami = JSON.parse(await runAsync(["whoami", "--json"], env)) as { profile: string; login: string };

    expect(firstLogin).toMatchObject({ profile: "jsonbored", login: "JSONbored" });
    expect(secondLogin).toMatchObject({ profile: "okto", login: "oktofeesh1" });
    expect(list.activeProfile).toBe("okto");
    expect(list.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "jsonbored", login: "JSONbored", authenticated: true }),
        expect.objectContaining({ name: "okto", login: "oktofeesh1", authenticated: true }),
      ]),
    );
    expect(firstWhoami).toMatchObject({ profile: "jsonbored", login: "JSONbored" });
    expect(secondWhoami).toMatchObject({ profile: "okto", login: "oktofeesh1" });
    expect(switched.activeProfile).toBe("jsonbored");
    expect(activeWhoami).toMatchObject({ profile: "jsonbored", login: "JSONbored" });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-jsonbored" }),
        expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-okto" }),
      ]),
    );
    expect(JSON.stringify(list)).not.toMatch(/session-jsonbored|session-okto|github-jsonbored|github-okto|gittensory-cli-/);
  }, 45_000);

  it("keeps environment tokens ahead of active profile sessions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const url = await startFixtureServer({
      onApiRequest: (request) => requests.push({ url: request.url, authorization: request.headers.authorization }),
    });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    await runAsync(["login", "--profile", "jsonbored", "--github-token", "github-jsonbored", "--json"], env);
    await runAsync(["profile", "switch", "jsonbored", "--json"], env);
    const whoami = JSON.parse(await runAsync(["whoami", "--json"], { ...env, GITTENSORY_TOKEN: "session-okto" })) as { profile: string; login: string };
    const status = JSON.parse(await runAsync(["status", "--json"], { ...env, GITTENSORY_TOKEN: "session-okto" })) as { profile: { tokenSource: string }; auth: { login: string } };

    expect(whoami).toMatchObject({ profile: "jsonbored", login: "oktofeesh1" });
    expect(status).toMatchObject({ auth: { login: "oktofeesh1" }, profile: { tokenSource: "environment" } });
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-okto" })]));
  });

  it("removes the default profile without rehydrating its legacy session token", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          apiUrl: "https://api.example.test",
          activeProfile: "default",
          profiles: {
            default: { session: { token: "default-session-token", login: "default-user", scopes: [] } },
            beta: { session: { token: "beta-session-token", login: "beta-user", scopes: [] } },
          },
          session: { token: "default-session-token", login: "default-user", scopes: [] },
        },
        null,
        2,
      ),
    );

    const removed = JSON.parse(await runAsync(["profile", "remove", "default", "--json"], { GITTENSORY_CONFIG_DIR: tempDir })) as { status: string; removedProfile: string; activeProfile: string };
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { activeProfile: string; profiles?: Record<string, unknown>; session?: unknown };

    expect(removed).toMatchObject({ status: "removed", removedProfile: "default", activeProfile: "beta" });
    expect(saved.activeProfile).toBe("beta");
    expect(saved.profiles).not.toHaveProperty("default");
    expect(saved.profiles).toHaveProperty("beta");
    expect(saved.session).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("default-session-token");
    expect(JSON.stringify(saved)).toContain("beta-session-token");
  });

  it("logs out only the selected profile and reports missing profiles safely", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const url = await startFixtureServer({
      onApiRequest: (request) => requests.push({ url: request.url, authorization: request.headers.authorization }),
    });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    await runAsync(["login", "--profile", "alpha", "--github-token", "github-jsonbored", "--json"], env);
    await runAsync(["login", "--profile", "beta", "--github-token", "github-okto", "--json"], env);
    const logout = JSON.parse(await runAsync(["logout", "--profile", "alpha", "--json"], env)) as { profile: string; status: string };
    const list = JSON.parse(await runAsync(["profile", "list", "--json"], env)) as { profiles: Array<{ name: string; authenticated: boolean; login: string | null }> };
    const betaWhoami = JSON.parse(await runAsync(["whoami", "--profile", "beta", "--json"], env)) as { profile: string; login: string };
    const missingStatus = JSON.parse(await runAsync(["status", "--profile", "missing", "--json"], env)) as { auth: { status: string }; profile: { name: string; configured: boolean; authenticated: boolean } };
    const doctor = JSON.parse(await runAsync(["doctor", "--profile", "missing", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], env)) as { profile: { name: string; configured: boolean }; checks: Array<{ name: string; status: string; detail: string }> };

    expect(logout).toMatchObject({ status: "logged_out", profile: "alpha" });
    expect(list.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "alpha", authenticated: false, login: null }),
        expect.objectContaining({ name: "beta", authenticated: true, login: "oktofeesh1" }),
      ]),
    );
    expect(betaWhoami).toMatchObject({ profile: "beta", login: "oktofeesh1" });
    expect(missingStatus).toMatchObject({ auth: { status: "unauthenticated" }, profile: { name: "missing", configured: false, authenticated: false } });
    expect(doctor.profile).toMatchObject({ name: "missing", configured: false });
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "auth", status: "fail" })]));
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ url: "/v1/auth/logout", authorization: "Bearer session-jsonbored" })]));
    expect(JSON.stringify({ logout, list, missingStatus, doctor })).not.toMatch(/session-jsonbored|session-okto|github-jsonbored|github-okto|gittensory-cli-/);
  }, 45_000);

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

    expect(status.package).toMatchObject({ name: "@jsonbored/gittensory-mcp", version: "0.7.0", latestStatus: "skipped" });
    expect(status.api.status).toBe("ok");
    expect(status.auth.login).toBe("JSONbored");

    const changelog = JSON.parse(run(["changelog", "--json"])) as { package: { version: string }; changelog: string };
    expect(changelog.package.version).toBe("0.7.0");
    expect(changelog.changelog).toContain("# Changelog");
  });

  it("sends redacted MCP package telemetry headers to the API", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const requests: Array<{ url: string | undefined; headers: IncomingMessage["headers"] }> = [];
    const url = await startFixtureServer({ onApiRequest: (request) => requests.push({ url: request.url, headers: request.headers }) });

    await runAsync(["status", "--json"], {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    });

    const sessionRequest = requests.find((request) => request.url === "/v1/auth/session");
    expect(sessionRequest?.headers["x-gittensory-mcp-package"]).toBe("@jsonbored/gittensory-mcp");
    expect(sessionRequest?.headers["x-gittensory-mcp-version"]).toBe("0.7.0");
    expect(sessionRequest?.headers["x-gittensory-mcp-client"]).toBe("gittensory-mcp-cli");
    const telemetryHeaders = JSON.stringify({
      package: sessionRequest?.headers["x-gittensory-mcp-package"],
      version: sessionRequest?.headers["x-gittensory-mcp-version"],
      client: sessionRequest?.headers["x-gittensory-mcp-client"],
    });
    expect(telemetryHeaders).not.toContain("session-token");
    expect(telemetryHeaders).not.toContain(tempDir);
  });
});
