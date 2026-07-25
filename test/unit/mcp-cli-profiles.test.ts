import { type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, runAsync, startFixtureServer } from "./support/mcp-cli-harness";
import mcpPackageJson from "../../packages/loopover-mcp/package.json";

// #8587: business-payload cases (status/changelog/telemetry-headers/device-flow login and the seeded
// profile-list case) call the exported runCli in-process (pattern from
// mcp-cli-contributor-profile-inprocess.test.ts). Multi-profile scenarios stay real subprocesses: the bin
// resolves the active profile from argv/config AT MODULE LOAD (bin/loopover-mcp.ts ~lines 365-368), so
// `--profile` selection and `profile switch` visibility only exist across separate process startups.
// One fixture server (started before the import, closed in afterAll) serves both transports.
type BinModule = {
  runCli: (args: string[]) => Promise<number | void>;
};

// Only the committed .ts source is imported (never dist); the variable indirection mirrors the template's
// MODULES array so tsc does not statically flag the .ts specifier (allowImportingTsExtensions is off).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

let mod: BinModule;
let sharedConfigDir = "";
let apiUrl = "";
const capturedRequests: Array<{ url: string | undefined; authorization: string | undefined; headers: IncomingMessage["headers"] }> = [];

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

function runInProcess(args: string[]): Promise<string> {
  return captureStdout(() => mod.runCli(args));
}

describe("loopover-mcp CLI — profiles", () => {
  let tempDir: string | null = null;

  beforeAll(async () => {
    sharedConfigDir = mkdtempSync(join(tmpdir(), "loopover-profiles-inprocess-"));
    // Seed the config the in-process module loads at import: the ndjson test's two credential-free profiles
    // (default + active "beta"); profile list needs only names to enumerate, so the fixture carries no
    // session token — the streaming format is what that test exercises.
    writeFileSync(
      join(sharedConfigDir, "config.json"),
      JSON.stringify(
        {
          apiUrl: "https://api.example.test",
          activeProfile: "beta",
          profiles: {
            default: { session: { login: "default-user", scopes: [] } },
            beta: { session: { login: "beta-user", scopes: [] } },
          },
        },
        null,
        2,
      ),
    );
    apiUrl = await startFixtureServer({
      onApiRequest: (request) => capturedRequests.push({ url: request.url, authorization: request.headers.authorization, headers: request.headers }),
      // #6792: only the device-flow login test polls these routes; a transient 429 precedes success.
      deviceFlowStart: { deviceCode: "device-code-1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 0 },
      deviceFlowPollResponses: [
        { status: 429, retryAfterSeconds: 1, body: { error: "rate_limited", routeClass: "normal" } },
        { body: { token: "device-session-token", login: "JSONbored", expiresAt: "2026-06-02T00:00:00.000Z", scopes: ["repo"] } },
      ],
    });
    // The bin reads these at module load, so set them BEFORE the dynamic import...
    process.env.LOOPOVER_API_URL = apiUrl;
    process.env.LOOPOVER_CONFIG_DIR = sharedConfigDir;
    process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
    process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
    mod = (await import(BIN_MODULE)) as unknown as BinModule;
    // ...and delete the module-load ones right after import so the kept subprocess tests only see the env
    // they pass explicitly.
    delete process.env.LOOPOVER_API_URL;
    delete process.env.LOOPOVER_CONFIG_DIR;
  }, 120_000);

  afterAll(async () => {
    await closeFixtureServer();
    if (sharedConfigDir) rmSync(sharedConfigDir, { recursive: true, force: true });
    delete process.env.LOOPOVER_API_TIMEOUT_MS;
    delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
  });

  beforeEach(() => {
    capturedRequests.length = 0;
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("stores, switches, and reports named MCP profiles without mixing sessions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const env = {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
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
    expect(capturedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-jsonbored" }),
        expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-okto" }),
      ]),
    );
    expect(JSON.stringify(list)).not.toMatch(/session-jsonbored|session-okto|github-jsonbored|github-okto|loopover-cli-/);
  }, 45_000);

  it("profile list --format ndjson streams one JSON object per profile (and --json stays pretty)", async () => {
    // The two-profile fixture (default + active "beta") is the config the in-process module loaded at
    // import — see the beforeAll seed.
    const lines = (await runInProcess(["profile", "list", "--format", "ndjson"])).trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as { name: string; active: boolean });
    expect(parsed.map((p) => p.name).sort()).toEqual(["beta", "default"]);
    // The active profile is flagged on its own record.
    expect(parsed.find((p) => p.name === "beta")?.active).toBe(true);
    // Each line is a bare profile object — not the {activeProfile, profiles} wrapper.
    for (const line of lines) expect(line).not.toContain("activeProfile");
    // --json still returns the pretty wrapper object (unchanged behavior).
    const pretty = JSON.parse(await runInProcess(["profile", "list", "--json"])) as { activeProfile: string; profiles: unknown[] };
    expect(pretty).toMatchObject({ activeProfile: "beta" });
    expect(pretty.profiles).toHaveLength(2);
  });

  it("keeps environment tokens ahead of active profile sessions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const env = {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    await runAsync(["login", "--profile", "jsonbored", "--github-token", "github-jsonbored", "--json"], env);
    await runAsync(["profile", "switch", "jsonbored", "--json"], env);
    const whoami = JSON.parse(await runAsync(["whoami", "--json"], { ...env, LOOPOVER_TOKEN: "session-okto" })) as { profile: string; login: string };
    const status = JSON.parse(await runAsync(["status", "--json"], { ...env, LOOPOVER_TOKEN: "session-okto" })) as { profile: { tokenSource: string }; auth: { login: string } };

    expect(whoami).toMatchObject({ profile: "jsonbored", login: "oktofeesh1" });
    expect(status).toMatchObject({ auth: { login: "oktofeesh1" }, profile: { tokenSource: "environment" } });
    expect(capturedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ url: "/v1/auth/session", authorization: "Bearer session-okto" })]));
  });

  it("removes the default profile without rehydrating its legacy session token", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
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

    const removed = JSON.parse(await runAsync(["profile", "remove", "default", "--json"], { LOOPOVER_CONFIG_DIR: tempDir })) as { status: string; removedProfile: string; activeProfile: string };
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
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const env = {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    await runAsync(["login", "--profile", "alpha", "--github-token", "github-jsonbored", "--json"], env);
    await runAsync(["login", "--profile", "beta", "--github-token", "github-okto", "--json"], env);
    const logout = JSON.parse(await runAsync(["logout", "--profile", "alpha", "--json"], env)) as { profile: string; status: string };
    const list = JSON.parse(await runAsync(["profile", "list", "--json"], env)) as { profiles: Array<{ name: string; authenticated: boolean; login: string | null }> };
    const betaWhoami = JSON.parse(await runAsync(["whoami", "--profile", "beta", "--json"], env)) as { profile: string; login: string };
    const missingStatus = JSON.parse(await runAsync(["status", "--profile", "missing", "--json"], env)) as { auth: { status: string }; profile: { name: string; configured: boolean; authenticated: boolean } };
    const doctor = JSON.parse(await runAsync(["doctor", "--profile", "missing", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], env)) as { profile: { name: string; configured: boolean }; checks: Array<{ name: string; status: string; detail: string }> };

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
    expect(capturedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ url: "/v1/auth/logout", authorization: "Bearer session-jsonbored" })]));
    expect(JSON.stringify({ logout, list, missingStatus, doctor })).not.toMatch(/session-jsonbored|session-okto|github-jsonbored|github-okto|loopover-cli-/);
  }, 45_000);

  it("reports package status and prints the packaged changelog", async () => {
    process.env.LOOPOVER_TOKEN = "session-token";
    try {
      const status = JSON.parse(await runInProcess(["status", "--json"])) as { package: { name: string; version: string; latestStatus: string }; api: { status: string }; auth: { login: string } };

      expect(status.package).toMatchObject({ name: "@loopover/mcp", version: mcpPackageJson.version, latestStatus: "skipped" });
      expect(status.api.status).toBe("ok");
      expect(status.auth.login).toBe("JSONbored");
    } finally {
      delete process.env.LOOPOVER_TOKEN;
    }

    const changelog = JSON.parse(await runInProcess(["changelog", "--json"])) as { package: { version: string }; changelog: string };
    expect(changelog.package.version).toBe(mcpPackageJson.version);
    expect(changelog.changelog).toContain("# Changelog");
  });

  it("sends redacted MCP package telemetry headers to the API", async () => {
    process.env.LOOPOVER_TOKEN = "session-token";
    try {
      await runInProcess(["status", "--json"]);
    } finally {
      delete process.env.LOOPOVER_TOKEN;
    }

    const sessionRequest = capturedRequests.find((request) => request.url === "/v1/auth/session");
    expect(sessionRequest?.headers["x-loopover-mcp-package"]).toBe("@loopover/mcp");
    expect(sessionRequest?.headers["x-loopover-mcp-version"]).toBe(mcpPackageJson.version);
    expect(sessionRequest?.headers["x-loopover-mcp-client"]).toBe("loopover-mcp-cli");
    const telemetryHeaders = JSON.stringify({
      package: sessionRequest?.headers["x-loopover-mcp-package"],
      version: sessionRequest?.headers["x-loopover-mcp-version"],
      client: sessionRequest?.headers["x-loopover-mcp-client"],
    });
    expect(telemetryHeaders).not.toContain("session-token");
    expect(telemetryHeaders).not.toContain(sharedConfigDir);
  });

  it("#6792: loginWithDeviceFlow backs off and keeps polling through a transient 429 from our own rate limiter instead of aborting", async () => {
    const login = JSON.parse(await runInProcess(["login", "--json"])) as { status: string; login: string };

    expect(login).toMatchObject({ status: "authenticated", login: "JSONbored" });
  }, 20000);
});
