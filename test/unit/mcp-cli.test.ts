import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    const cursor = JSON.parse(run(["init-client", "--print", "cursor", "--json"])) as { snippet: string };
    expect(cursor.snippet).toBe(claude.snippet);

    const generic = JSON.parse(run(["init-client", "--print", "mcp", "--json"])) as { snippet: string };
    expect(generic.snippet).toBe(claude.snippet);
  });

  it("runs doctor against a local health/session fixture", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const secretRoot = join(tempDir, "secret-gittensor");
    const secretConfigDir = join(tempDir, "secret-config");
    mkdirSync(secretConfigDir, { recursive: true });
    writeFileSync(join(secretConfigDir, "config.json"), JSON.stringify({ apiUrl: url }), { mode: 0o600 });
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: secretConfigDir,
        GITTENSOR_ROOT: secretRoot,
        GITTENSOR_SCORE_PREVIEW_CMD: `node ${join(process.cwd(), "test/fixtures/local-scorer/scorer-malformed.mjs")}`,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { status: string; config: { configured: boolean }; checks: Array<{ name: string; status: string; detail: string; remediation?: string }> };

    const serialized = JSON.stringify(payload);
    expect(payload.status).toMatch(/ok|warnings/);
    expect(serialized).not.toMatch(/secret-gittensor|secret-config/);
    expect(payload.config.configured).toBe(true);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "api_health", status: "pass" }),
        expect.objectContaining({ name: "auth", status: "pass", detail: expect.stringContaining("JSONbored") }),
        expect.objectContaining({ name: "source_upload", status: "pass" }),
        expect.objectContaining({ name: "git_metadata", status: "pass" }),
        expect.objectContaining({ name: "version", status: "pass" }),
        expect.objectContaining({ name: "api_compatibility", status: "pass" }),
        expect.objectContaining({ name: "local_scorer", status: "warn" }),
        expect.objectContaining({ name: "gittensor_root", status: "pass" }),
      ]),
    );
    const localScorer = payload.checks.find((check) => check.name === "local_scorer");
    expect(localScorer?.detail).toMatch(/malformed_json/);
    expect(localScorer?.detail).not.toMatch(join(process.cwd(), "test/fixtures"));
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
    const url = await startFixtureServer({ latestVersion: "0.3.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as {
      package: { state: string; updateAvailable: boolean; upgradeCommand?: string };
      apiCompatibility: { status: string; source: string; minVersion: string; latestRecommendedVersion: string; apiVersion: string };
    };

    expect(payload.package.state).toBe("current");
    expect(payload.package.updateAvailable).toBe(false);
    expect(payload.package.upgradeCommand).toBeUndefined();
    expect(payload.apiCompatibility).toMatchObject({
      status: "compatible",
      source: "compatibility_endpoint",
      minVersion: "0.2.0",
      latestRecommendedVersion: "0.3.0",
      apiVersion: "0.1.0",
    });
  });

  it("orders prerelease npm versions correctly (release outranks prerelease of the same core)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    // Local 0.3.0 (release) vs latest 0.3.0-rc.1 (prerelease) -> local is ahead, not stale.
    const aheadUrl = await startFixtureServer({ latestVersion: "0.3.0-rc.1" });
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

    // Local 0.3.0 vs a higher-core prerelease 0.4.0-rc.1 -> stale.
    const staleUrl = await startFixtureServer({ latestVersion: "0.4.0-rc.1" });
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
    const url = await startFixtureServer({ npmStatus: 500, compatibilityStatus: 404 });
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
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "version", status: "warn" })]));
    expect(doctor.checks).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "version", status: "error" })]));
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
    const url = await startFixtureServer({ compatibilityStatus: 404 });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { apiCompatibility: { status: string } };
    expect(payload.apiCompatibility.status).toBe("unavailable");

    const doctor = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { checks: Array<{ name: string; status: string }> };
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "api_compatibility", status: "warn" })]));
  });

  it("falls back to legacy health compatibility when the endpoint is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ compatibilityStatus: 503, minMcpVersion: "0.2.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
        GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { apiCompatibility: { status: string; source: string; minVersion: string } };
    expect(payload.apiCompatibility).toMatchObject({ status: "compatible", source: "health", minVersion: "0.2.0" });
  });

  it("uses API recommended package metadata when the npm registry is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer({ npmStatus: 500, latestRecommendedMcpVersion: "0.4.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        GITTENSORY_API_URL: url,
        GITTENSORY_NPM_REGISTRY_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; latestStatus: string; latestVersion: string; upgradeCommand: string } };
    expect(payload.package).toMatchObject({
      state: "stale",
      latestStatus: "api",
      latestVersion: "0.4.0",
      upgradeCommand: "npm install -g @jsonbored/gittensory-mcp@latest",
    });
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

    expect(status.package).toMatchObject({ name: "@jsonbored/gittensory-mcp", version: "0.3.0", latestStatus: "skipped" });
    expect(status.api.status).toBe("ok");
    expect(status.auth.login).toBe("JSONbored");

    const changelog = JSON.parse(run(["changelog", "--json"])) as { package: { version: string }; changelog: string };
    expect(changelog.package.version).toBe("0.3.0");
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
    expect(sessionRequest?.headers["x-gittensory-mcp-version"]).toBe("0.3.0");
    expect(sessionRequest?.headers["x-gittensory-mcp-client"]).toBe("gittensory-mcp-cli");
    const telemetryHeaders = JSON.stringify({
      package: sessionRequest?.headers["x-gittensory-mcp-package"],
      version: sessionRequest?.headers["x-gittensory-mcp-version"],
      client: sessionRequest?.headers["x-gittensory-mcp-client"],
    });
    expect(telemetryHeaders).not.toContain("session-token");
    expect(telemetryHeaders).not.toContain(tempDir);
  });

  it("caches last-good decision packs and returns explicitly stale local fallback when the API is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "100",
    };

    const online = JSON.parse(await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)) as { status: string; source: string };
    expect(online).toMatchObject({ status: "ready", source: "snapshot" });

    const cacheText = readDecisionPackCacheText(tempDir);
    expect(cacheText).not.toMatch(/must stay local|wallet-value|hotkey-value|\/tmp\/source/i);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const offline = JSON.parse(await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)) as {
      source: string;
      stale: boolean;
      freshness: string;
      cachedAt: string;
      cache: { source: string; clearCommand: string; rerunGuidance: string };
    };
    expect(offline).toMatchObject({
      source: "local_cache",
      stale: true,
      freshness: "stale",
      cache: { source: "local_cache", clearCommand: "gittensory-mcp cache clear" },
    });
    expect(offline.cachedAt).toEqual(expect.any(String));
    expect(offline.cache.rerunGuidance).toMatch(/Retry when Gittensory API access is restored/);

    const repoDecision = JSON.parse(await runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], env)) as {
      status: string;
      source: string;
      stale: boolean;
      decision: { repoFullName: string; recommendation: string };
    };
    expect(repoDecision).toMatchObject({
      status: "ready",
      source: "local_cache",
      stale: true,
      decision: { repoFullName: "JSONbored/gittensory", recommendation: "pursue" },
    });
  });

  it("ignores incompatible decision-pack cache entries and clears cache entries on request", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
      GITTENSORY_API_TIMEOUT_MS: "100",
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const cachePath = decisionPackCacheFile(tempDir);
    const entry = JSON.parse(readFileSync(cachePath, "utf8"));
    writeFileSync(cachePath, `${JSON.stringify({ ...entry, schemaVersion: 999 }, null, 2)}\n`, { mode: 0o600 });

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)).rejects.toThrow(/fetch failed|ECONNREFUSED|aborted/i);

    const cleared = JSON.parse(run(["cache", "clear", "--json"], env)) as { status: string; removed: number };
    expect(cleared).toMatchObject({ status: "cleared", removed: 1 });
    const cacheStatus = JSON.parse(run(["cache", "status", "--json"], env)) as { entries: number };
    expect(cacheStatus.entries).toBe(0);
  });

  it("does not use stale decision-pack cache for authorization failures", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const fixtureOptions: { decisionPackStatus?: number } = {};
    const url = await startFixtureServer(fixtureOptions);
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    fixtureOptions.decisionPackStatus = 403;

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], env)).rejects.toThrow(/Gittensory API 403/);
  });

  it("does not use stale decision-pack cache when local credentials are missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    };

    await runAsync(["decision-pack", "--login", "JSONbored", "--json"], env);
    const withoutToken = {
      ...env,
      GITTENSORY_API_TOKEN: "",
      GITTENSORY_TOKEN: "",
      GITTENSORY_MCP_TOKEN: "",
    };

    await expect(runAsync(["decision-pack", "--login", "JSONbored", "--json"], withoutToken)).rejects.toThrow(/Run `gittensory-mcp login`/);
    await expect(runAsync(["repo-decision", "--login", "JSONbored", "--repo", "JSONbored/gittensory", "--json"], withoutToken)).rejects.toThrow(
      /Run `gittensory-mcp login`/,
    );
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

  it("prints copy-paste public-safe markdown for agent packet output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "codex/public-safe-pr-packets");
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src/packet.ts"), "export const packet = true;\n");
    const url = await startFixtureServer();
    const output = await runAsync(
      ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD", "--body", "Closes #39", "--validation", "passed|npm test|packet tests passed"],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    expect(output).toContain("# Public-safe PR packet");
    expect(output).toContain("## Validation");
    expect(output).toContain("Closes #39");
    expect(output).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|raw[-_\s]?trust|private[-_\s]?reviewability|reviewability|export const packet/i);
  });

  it("rejects unsafe server-provided packet markdown before non-json output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "codex/public-safe-pr-packets");

    for (const unsafePhrase of ["score: 1.15", "reward estimate", "wallet address", "hotkey id", "raw-trust: 0.7", "private-reviewability: ready", "raw_trust: 0.7", "private_reviewability: ready", "trust_score: 0.4"]) {
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
      const url = await startFixtureServer({ packetMarkdown: `# Public-safe PR packet\n\n- ${unsafePhrase}\n` });
      await expect(
        runAsync(
          ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD"],
          {
            GITTENSORY_API_URL: url,
            GITTENSORY_TOKEN: "session-token",
            GITTENSORY_CONFIG_DIR: tempDir,
          },
        ),
      ).rejects.toThrow("Refusing to print unsafe public packet markdown from the server.");
    }
  }, 10000);

  it("sends bounded structured validation summaries without local logs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
        "--base",
        "HEAD",
        "--validation",
        "focused|npm run test:unit|1234ms|unit passed raw_trust=0.4 /Users/example/log.txt",
        "--validation-command",
        "npm run lint",
        "--validation-status",
        "exit code 1",
        "--validation-duration",
        "2s",
        "--validation-summary",
        "lint failed at C:/Users/alice/raw.log and /tmp/raw.log",
        "--json",
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { validation: Array<{ command: string; status: string; durationMs?: number; exitCode?: number; summary?: string }> };
    expect(packet.validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm run test:unit", status: "focused", durationMs: 1234, exitCode: 0 }),
        expect.objectContaining({ command: "npm run lint", status: "failed", durationMs: 2000, exitCode: 1 }),
      ]),
    );
    expect(JSON.stringify(packet.validation)).not.toMatch(/raw_trust|\/Users\/example|\/tmp\/raw/i);
    expect(JSON.stringify(packet.validation)).not.toMatch(/C:\/Users|alice/i);
  });

  it("sends branch eligibility metadata without local source contents", async () => {
    tempDir = createPacketRepo();
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src/eligible.ts"), "export const source = 'must stay local';\n");
    git(tempDir, "add", "src/eligible.ts");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
        "--base",
        "HEAD",
        "--body",
        "Fixes #90",
        "--branch-eligibility",
        "ineligible",
        "--branch-eligibility-source",
        "github_metadata",
        "--branch-eligibility-reason",
        "head branch is not eligible",
        "--branch-eligibility-stale",
        "false",
        "--json",
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { branchEligibility: { status: string; source: string; reason: string; stale: boolean }; changedFiles: Array<{ path: string }> };
    expect(packet.branchEligibility).toMatchObject({ status: "ineligible", source: "github_metadata", reason: "head branch is not eligible", stale: false });
    expect(packet.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/eligible.ts" })]));
    expect(JSON.stringify(packet)).not.toMatch(/must stay local|export const source/);
  });

  it("classifies nonzero validation status phrases as failed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    const requests: unknown[] = [];
    const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
    await runAsync(
      [
        "agent",
        "packet",
        "--login",
        "oktofeesh1",
        "--cwd",
        tempDir,
        "--base",
        "HEAD",
        "--validation-command",
        "npm test",
        "--validation-status",
        "status: 2",
        "--json",
      ],
      {
        GITTENSORY_API_URL: url,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_CONFIG_DIR: tempDir,
      },
    );

    const packet = requests[0] as { validation: Array<{ command: string; status: string; exitCode?: number }> };
    expect(packet.validation).toEqual(expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 2 })]));
  });

  it("classifies bare nonzero validation statuses as failed", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, [
      "--validation",
      "npm test|1",
      "--validation-command",
      "npm run lint",
      "--validation-status",
      "2",
    ]);

    expect(validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm test", status: "failed", exitCode: 1 }),
        expect.objectContaining({ command: "npm run lint", status: "failed", exitCode: 2 }),
      ]),
    );
  });

  it("does not infer HTTP status summaries as process exit codes", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, ["--validation", "npm run e2e|HTTP status 200 OK"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm run e2e", status: "not_run", summary: "HTTP status 200 OK" })]),
    );
    expect(validation[0]).not.toHaveProperty("exitCode");
  });

  it("infers expanded validation failures from summaries when status is absent", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, ["--validation-command", "npm test", "--validation-summary", "exit code 1"]);

    expect(validation).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm test", status: "failed", exitCode: 1, summary: "exit code 1" })]),
    );
  });

  it("redacts space-containing local paths and private metric values from validation text", async () => {
    tempDir = createPacketRepo();
    const validation = await capturePacketValidation(tempDir, [
      "--validation-command",
      "node /Users/Alice Smith/project/run.js",
      "--validation-status",
      "failed",
      "--validation-summary",
      "log=C:\\Users\\Alice Smith\\raw.log raw_trust=0.72 private_reviewability=ready",
    ]);

    expect(validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "node <local-path>",
          status: "failed",
          summary: "log=<local-path> [redacted] [redacted]",
        }),
      ]),
    );
    expect(JSON.stringify(validation)).not.toMatch(/Alice Smith|Smith[\\/]|raw\.log|0\.72|ready|\[redacted\]=/);
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

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createPacketRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Gittensory Test");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "remote", "add", "origin", "git@github.com:JSONbored/gittensory.git");
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "initial commit");
  return cwd;
}

async function capturePacketValidation(tempDir: string, validationArgs: string[]) {
  const requests: unknown[] = [];
  const url = await startFixtureServer({ onPacketRequest: (body) => requests.push(body) });
  await runAsync(
    ["agent", "packet", "--login", "oktofeesh1", "--cwd", tempDir, "--base", "HEAD", ...validationArgs, "--json"],
    {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_CONFIG_DIR: tempDir,
    },
  );
  return (requests[0] as { validation: Array<{ command: string; status: string; exitCode?: number; summary?: string }> }).validation;
}

function decisionPackCacheFile(configDir: string) {
  const cacheDir = join(configDir, "cache", "decision-packs");
  const files = readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const file = files[0];
  if (!file) throw new Error("expected one decision-pack cache file");
  return join(cacheDir, file);
}

function readDecisionPackCacheText(configDir: string) {
  return readFileSync(decisionPackCacheFile(configDir), "utf8");
}

async function startFixtureServer(
  options: {
    latestVersion?: string;
    latestRecommendedMcpVersion?: string;
    minMcpVersion?: string;
    compatibilityStatus?: number;
    npmStatus?: number;
    decisionPackStatus?: number;
    packetMarkdown?: string;
    onPacketRequest?: (body: unknown) => void;
    onApiRequest?: (request: IncomingMessage) => void;
  } = {},
) {
  server = createServer(async (request, response) => {
    options.onApiRequest?.(request);
    response.setHeader("content-type", "application/json");
    if (request.url && request.url.includes("gittensory-mcp/latest")) {
      if (options.npmStatus && options.npmStatus >= 400) {
        response.statusCode = options.npmStatus;
        response.end(JSON.stringify({ error: "registry_error" }));
        return;
      }
      response.end(JSON.stringify({ version: options.latestVersion ?? "0.3.0" }));
      return;
    }
    if (request.url === "/v1/mcp/compatibility") {
      if (options.compatibilityStatus && options.compatibilityStatus >= 400) {
        response.statusCode = options.compatibilityStatus;
        response.end(JSON.stringify({ error: "compatibility_unavailable" }));
        return;
      }
      const minimumSupportedVersion = options.minMcpVersion ?? "0.2.0";
      const latestRecommendedVersion = options.latestRecommendedMcpVersion ?? options.latestVersion ?? "0.3.0";
      response.end(
        JSON.stringify({
          status: "ok",
          service: "gittensory-api",
          apiVersion: "0.1.0",
          mcp: {
            packageName: "@jsonbored/gittensory-mcp",
            minimumSupportedVersion,
            latestRecommendedVersion,
            latestPackageVersion: latestRecommendedVersion,
            supportedVersionRange: `>=${minimumSupportedVersion}`,
            upgradeCommand: "npm install -g @jsonbored/gittensory-mcp@latest",
            npxFallbackCommand: "npx @jsonbored/gittensory-mcp@latest <command>",
          },
          compatibilityWarnings: [],
          breakingChanges: [],
          generatedAt: "2026-05-30T00:00:00.000Z",
        }),
      );
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
    if (request.url === "/v1/contributors/JSONbored/decision-pack" && request.method === "GET") {
      if (options.decisionPackStatus && options.decisionPackStatus >= 400) {
        response.statusCode = options.decisionPackStatus;
        response.end(JSON.stringify({ error: "decision_pack_unavailable" }));
        return;
      }
      response.end(JSON.stringify(decisionPackFixture()));
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
    if (request.url === "/v1/agent/prepare-pr-packet" && request.method === "POST") {
      options.onPacketRequest?.(await readJsonRequest(request));
      response.end(JSON.stringify(agentPacketFixture(options.packetMarkdown)));
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

function readJsonRequest(request: IncomingMessage) {
  return new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function agentPacketFixture(markdown = "# Public-safe PR packet\n\n## Linked Context\n- Closes #39\n\n## Validation\n- passed: npm test (packet tests passed)\n") {
  return {
    ...agentFixture(),
    actions: [
      {
        id: "action-packet",
        runId: "run-1",
        actionType: "prepare_pr_packet",
        status: "ready",
        recommendation: "Use this public-safe packet.",
        why: ["Fixture"],
        blockedBy: [],
        publicSafeSummary: "Packet ready.",
        approvalRequired: false,
        safetyClass: "public_safe",
        payload: {
          prPacket: {
            markdown,
          },
        },
      },
    ],
  };
}

function decisionPackFixture() {
  return {
    status: "ready",
    source: "snapshot",
    login: "JSONbored",
    generatedAt: "2026-06-01T00:00:00.000Z",
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: "scoring-1",
    profile: {
      login: "JSONbored",
      github: { topLanguages: ["TypeScript"] },
      source: { cache: "fixture" },
      officialStats: { totalMergedPrs: 12, hotkey: "hotkey-value", wallet: "wallet-value" },
      registeredRepoActivity: {},
      trustSignals: {},
    },
    outcomeHistory: {},
    roleContexts: [],
    opportunities: [],
    repoDecisions: [
      {
        repoFullName: "JSONbored/gittensory",
        recommendation: "pursue",
        nextActions: ["Pick one narrow change."],
        changedFiles: [{ path: "src/cache.ts", content: "must stay local" }],
        localPath: "/tmp/source/private.ts",
      },
    ],
    topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "JSONbored/gittensory", priorityScore: 50 }],
    cleanupFirst: [],
    pursueRepos: [{ repoFullName: "JSONbored/gittensory", recommendation: "pursue" }],
    avoidRepos: [],
    maintainerLaneRepos: [],
    scoreBlockers: [],
    dataQuality: { signalFidelity: { status: "complete" } },
    summary: "fixture decision pack",
    nextActions: ["Pick one narrow change."],
    sourceContents: "must stay local",
  };
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
