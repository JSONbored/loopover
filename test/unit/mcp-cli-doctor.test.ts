import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bin, closeFixtureServer, createPacketRepo, git, runAsync, startFixtureServer } from "./support/mcp-cli-harness";
import mcpPackageJson from "../../packages/loopover-mcp/package.json";

// A "higher-core prerelease" fixture (release outranks any prerelease of the same core, but a
// HIGHER-core prerelease still beats a lower-core release) needs a version strictly above the local
// package's own -- computed instead of hardcoded so it stays correct across every future release.
const oneMinorAboveLocal = (() => {
  const [major, minor] = mcpPackageJson.version.split(".").map(Number) as [number, number, number];
  return `${major}.${minor + 1}.0`;
})();

describe("loopover-mcp CLI — doctor", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("runs doctor against a local health/session fixture", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    const secretRoot = join(tempDir, "secret-gittensor");
    const secretConfigDir = join(tempDir, "secret-config");
    mkdirSync(secretConfigDir, { recursive: true });
    writeFileSync(join(secretConfigDir, "config.json"), JSON.stringify({ apiUrl: url }), { mode: 0o600 });
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: secretConfigDir,
        GITTENSOR_ROOT: secretRoot,
        GITTENSOR_SCORE_PREVIEW_CMD: `node ${join(process.cwd(), "test/fixtures/local-scorer/scorer-malformed.mjs")}`,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as {
      status: string;
      config: { configured: boolean };
      checklist: Array<{ id: string; title: string; status: string; checks?: Array<{ name: string; status: string; detail: string; remediation?: string }> }>;
      nextCommand: { command: string; reason: string };
      checks: Array<{ name: string; status: string; detail: string; remediation?: string }>;
    };

    const serialized = JSON.stringify(payload);
    expect(payload.status).toMatch(/ok|warnings/);
    expect(serialized).not.toMatch(/secret-gittensor|secret-config/);
    expect(payload.config.configured).toBe(true);
    expect(payload.checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "auth", title: "Auth", status: "pass" }),
        expect.objectContaining({ id: "api_compatibility", title: "API compatibility", status: "pass" }),
        // Not asserting status here: this group's own "client_path" sub-check (findExecutable("loopover-mcp"))
        // does a plain PATH scan for a "loopover-mcp" executable, which resolves via node_modules/.bin's npm-
        // workspace bin-link -- but npm only creates that symlink if bin/loopover-mcp.js already exists at
        // `npm ci` time. Since compiled output is no longer committed (build(mcp,miner): stop committing
        // compiled .js/.d.ts entirely), every CI job's npm ci runs before any build step, so the symlink is
        // never created there, regardless of a later build -- this group's status is genuinely "warn" in that
        // environment and "pass" only where something else (a real global install, e.g.) already put
        // loopover-mcp on PATH. Checked explicitly below instead, tolerating either.
        expect.objectContaining({ id: "local_repo_readiness", title: "Local repo readiness" }),
        expect.objectContaining({ id: "scorer_availability", title: "Scorer availability", status: "warn" }),
        expect.objectContaining({ id: "output_safety", title: "Output safety", status: "pass" }),
        expect.objectContaining({ id: "next_command", title: "Next command", status: "warn" }),
      ]),
    );
    const localRepoReadiness = payload.checklist.find((group) => group.id === "local_repo_readiness");
    expect(["pass", "warn"]).toContain(localRepoReadiness?.status);
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp doctor --json",
      reason: expect.stringContaining("local scorer"),
    });
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

  it("shell-quotes doctor next command values derived from local repo metadata", async () => {
    tempDir = createPacketRepo();
    git(tempDir, "remote", "set-url", "origin", "git@github.com:owner/repo$(touch /tmp/av_pwned).git");
    const url = await startFixtureServer();
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
      GITTENSOR_SCORE_PREVIEW_CMD: `node ${join(process.cwd(), "test/fixtures/local-scorer/scorer-success.mjs")}`,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    const payload = JSON.parse(await runAsync(["doctor", "--cwd", tempDir, "--json"], env)) as { nextCommand: { command: string } };
    expect(payload.nextCommand.command).toBe("loopover-mcp review-pr --login JSONbored --repo 'owner/repo$(touch /tmp/av_pwned)' --json");
    expect(payload.nextCommand.command).not.toContain("--repo owner/repo$(");

    const humanOutput = await runAsync(["doctor", "--cwd", tempDir], env);
    expect(humanOutput).toContain("loopover-mcp review-pr --login JSONbored --repo 'owner/repo$(touch /tmp/av_pwned)' --json");
    expect(humanOutput).not.toContain("--repo owner/repo$(");
  });

  it("uses doctor as a first-run auth checklist when no local session is configured", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_API_TOKEN: "",
        LOOPOVER_TOKEN: "",
        LOOPOVER_MCP_TOKEN: "",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as {
      status: string;
      checklist: Array<{ id: string; status: string; checks?: Array<{ name: string; status: string }> }>;
      nextCommand: { command: string; reason: string };
    };

    const auth = payload.checklist.find((group) => group.id === "auth");
    expect(payload.status).toBe("needs_attention");
    expect(auth).toMatchObject({ status: "fail" });
    expect(auth?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "auth", status: "fail" })]));
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp login --profile default",
      reason: expect.stringContaining("Authenticate"),
    });
    expect(JSON.stringify(payload)).not.toContain(tempDir);
  });

  it("reports a stale global install with an exact upgrade command and npx fallback", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ latestVersion: "9.9.9" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; latestVersion: string; updateAvailable: boolean; upgradeCommand: string; npxFallback: string } };

    expect(payload.package).toMatchObject({
      state: "stale",
      latestVersion: "9.9.9",
      updateAvailable: true,
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });
    expect(payload.package.npxFallback).toContain("npx @loopover/mcp@latest");
  });

  it("reports a current install without upgrade guidance", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ latestVersion: mcpPackageJson.version, minMcpVersion: "0.5.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
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
      minVersion: "0.5.0",
      latestRecommendedVersion: mcpPackageJson.version,
      apiVersion: "0.1.0",
    });
  });

  it("orders prerelease npm versions correctly (release outranks prerelease of the same core)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    // Local 0.5.0 (release) vs latest 0.5.0-rc.1 (prerelease) -> local is ahead, not stale.
    const aheadUrl = await startFixtureServer({ latestVersion: "0.5.0-rc.1" });
    const ahead = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: aheadUrl,
        LOOPOVER_NPM_REGISTRY_URL: aheadUrl,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; updateAvailable: boolean } };
    expect(ahead.package).toMatchObject({ state: "ahead", updateAvailable: false });
    await closeFixtureServer();

    // Local (mcpPackageJson.version) vs a higher-core prerelease (one minor above) -> stale.
    const staleUrl = await startFixtureServer({ latestVersion: `${oneMinorAboveLocal}-rc.1` });
    const stale = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: staleUrl,
        LOOPOVER_NPM_REGISTRY_URL: staleUrl,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string } };
    expect(stale.package.state).toBe("stale");
  });

  it("treats an unavailable npm registry as a warning, not a hard failure", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ npmStatus: 500, compatibilityStatus: 404 });
    const status = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; updateAvailable: boolean } };
    expect(status.package.state).toBe("unavailable");
    expect(status.package.updateAvailable).toBe(false);

    const doctor = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { status: string; checks: Array<{ name: string; status: string; remediation?: string }> };
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "version", status: "warn" })]));
    expect(doctor.checks).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "version", status: "error" })]));
  });

  it("flags a stale install in doctor with upgrade remediation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ latestVersion: oneMinorAboveLocal });
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { checks: Array<{ name: string; status: string; remediation?: string }> };
    const version = payload.checks.find((check) => check.name === "version");
    expect(version).toMatchObject({ status: "warn" });
    expect(version?.remediation).toContain("npm install -g @loopover/mcp@latest");
    expect(version?.remediation).toContain("npx @loopover/mcp@latest");
  });

  it("reports API compatibility as unavailable when the API does not advertise a minimum version", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ compatibilityStatus: 404 });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { apiCompatibility: { status: string } };
    expect(payload.apiCompatibility.status).toBe("unavailable");

    const doctor = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { checks: Array<{ name: string; status: string }> };
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "api_compatibility", status: "warn" })]));
  });

  it("falls back to legacy health compatibility when the endpoint is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ compatibilityStatus: 503, minMcpVersion: "0.4.0" });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { apiCompatibility: { status: string; source: string; minVersion: string } };
    expect(payload.apiCompatibility).toMatchObject({ status: "compatible", source: "health", minVersion: "0.4.0" });
  });

  it("uses API recommended package metadata when the npm registry is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ npmStatus: 500, latestRecommendedMcpVersion: oneMinorAboveLocal });
    const payload = JSON.parse(
      await runAsync(["status", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_NPM_REGISTRY_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
      }),
    ) as { package: { state: string; latestStatus: string; latestVersion: string; upgradeCommand: string } };
    expect(payload.package).toMatchObject({
      state: "stale",
      latestStatus: "api",
      latestVersion: oneMinorAboveLocal,
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });
  });

  it("prints API compatibility unknown when the minimum version is unparseable (#6263)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ minMcpVersion: "not-a-semver" });
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };
    const statusJson = JSON.parse(await runAsync(["status", "--json"], env)) as {
      apiCompatibility: { status: string; minVersion: string };
    };
    expect(statusJson.apiCompatibility).toMatchObject({ status: "unknown", minVersion: "not-a-semver" });

    // Human-readable status used to omit this arm entirely; keep it visible like doctor().
    const statusOutput = await runAsync(["status"], env);
    expect(statusOutput).toContain("unsupported minimum client version");
    expect(statusOutput).toContain("not-a-semver");
  });

  it("flags API compatibility mismatches with upgrade guidance", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ minMcpVersion: "9.0.0" });
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };
    const status = JSON.parse(await runAsync(["status", "--json"], env)) as { apiCompatibility: { status: string; minVersion: string; upgradeCommand: string } };
    expect(status.apiCompatibility).toMatchObject({
      status: "incompatible",
      minVersion: "9.0.0",
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });

    const doctor = JSON.parse(await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], env)) as {
      checklist: Array<{ id: string; status: string }>;
      nextCommand: { command: string; reason: string };
      checks: Array<{ name: string; status: string; remediation?: string }>;
    };
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api_compatibility",
          status: "fail",
          remediation: "npm install -g @loopover/mcp@latest",
        }),
      ]),
    );
    expect(doctor.checklist).toEqual(expect.arrayContaining([expect.objectContaining({ id: "api_compatibility", status: "fail" })]));
    expect(doctor.nextCommand).toMatchObject({
      command: "npm install -g @loopover/mcp@latest",
      reason: expect.stringContaining("Upgrade"),
    });
  });

  it("keeps source upload unsupported and fail-closed in the doctor checklist", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        LOOPOVER_UPLOAD_SOURCE: "true",
      }),
    ) as {
      sourceUploadSupported: boolean;
      checklist: Array<{ id: string; status: string; checks?: Array<{ name: string; status: string; remediation?: string }> }>;
      nextCommand: { command: string; reason: string };
    };

    const outputSafety = payload.checklist.find((group) => group.id === "output_safety");
    expect(payload.sourceUploadSupported).toBe(false);
    expect(outputSafety).toMatchObject({ status: "fail" });
    expect(outputSafety?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "source_upload", status: "fail" })]));
    expect(payload.nextCommand).toMatchObject({
      command: "unset LOOPOVER_UPLOAD_SOURCE",
      reason: expect.stringContaining("metadata"),
    });
  });

  it("points missing local repo readiness at an explicit repo-aware doctor command", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    const payload = JSON.parse(
      await runAsync(["doctor", "--cwd", tempDir, "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as {
      checklist: Array<{ id: string; status: string; checks?: Array<{ name: string; status: string; detail: string }> }>;
      nextCommand: { command: string; reason: string };
    };

    const repoReadiness = payload.checklist.find((group) => group.id === "local_repo_readiness");
    expect(repoReadiness).toMatchObject({ status: "warn" });
    expect(repoReadiness?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "git_metadata", status: "warn" })]));
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp doctor --repo owner/repo --json",
      reason: expect.stringContaining("git checkout"),
    });
    expect(JSON.stringify(payload)).not.toContain(tempDir);
  });

  it("does not print configured tokens or local absolute paths in status or doctor output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer({ latestVersion: "9.9.9", minMcpVersion: "9.0.0" });
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_NPM_REGISTRY_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
    };
    const statusOutput = await runAsync(["status"], env);
    const statusJsonOutput = await runAsync(["status", "--json"], env);
    const doctorOutput = await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover"], env);
    const doctorJsonOutput = await runAsync(["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"], env);
    for (const output of [statusOutput, statusJsonOutput, doctorOutput, doctorJsonOutput]) {
      expect(output).not.toContain("session-token");
      expect(output).not.toContain(tempDir);
      expect(output).not.toMatch(/"configPath"/);
    }
    expect(statusOutput).not.toContain("session-token");
    // Sanity: upgrade guidance still surfaces in human-readable output.
    expect(statusOutput).toContain("npm install -g @loopover/mcp@latest");
  });

  it("keeps doctor exit code 0 by default even when a check fails", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    // No token configured -> the auth check fails -> status "needs_attention".
    const payload = JSON.parse(
      await runAsync(["doctor", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { status: string; checks: Array<{ name: string; status: string }> };
    expect(payload.status).toBe("needs_attention");
    expect(payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "auth", status: "fail" })]));
  });

  it("exits non-zero from doctor --exit-code when a check fails", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    let exitCode = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [bin, "doctor", "--exit-code", "--json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPOVER_API_TIMEOUT_MS: "1000",
          LOOPOVER_API_URL: url,
          LOOPOVER_CONFIG_DIR: tempDir,
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const execError = error as { status?: number | null; stdout?: string };
      exitCode = execError.status ?? 0;
      stdout = execError.stdout ?? "";
    }
    expect(exitCode).toBe(1);
    // The diagnostic report is still printed; only the process exit code changes.
    expect((JSON.parse(stdout) as { status: string }).status).toBe("needs_attention");
  });

  it("keeps doctor --exit-code at 0 when checks pass", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    // runAsync resolves only on a zero exit code, so reaching the assertion proves exit 0.
    const payload = JSON.parse(
      await runAsync(["doctor", "--exit-code", "--json"], {
        LOOPOVER_API_URL: url,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_CONFIG_DIR: tempDir,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      }),
    ) as { status: string };
    expect(payload.status).toMatch(/ok|warnings/);
  });
});
