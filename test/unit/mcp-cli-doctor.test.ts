import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  bin,
  closeFixtureServer,
  createPacketRepo,
  git,
  startFixtureServer,
} from "./support/mcp-cli-harness";
import mcpPackageJson from "../../packages/loopover-mcp/package.json";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

// A "higher-core prerelease" fixture (release outranks any prerelease of the same core, but a
// HIGHER-core prerelease still beats a lower-core release) needs a version strictly above the local
// package's own -- computed instead of hardcoded so it stays correct across every future release.
const oneMinorAboveLocal = (() => {
  const [major, minor] = mcpPackageJson.version.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  return `${major}.${minor + 1}.0`;
})();

// #8587: these doctor/status scenarios now run the CLI in-process (same shape as
// mcp-cli-contributor-profile-inprocess.test.ts) instead of spawning a subprocess per call. The bin reads
// LOOPOVER_API_URL, LOOPOVER_NPM_REGISTRY_URL, and LOOPOVER_CONFIG_DIR at module load, so ONE fixture
// server and config dir are fixed before the dynamic import; per-test variation goes through
// `fixtureOptions` (the harness route handlers read the options object at request time, so mutating it
// between tests changes responses without restarting the server) and through call-time env vars
// (LOOPOVER_TOKEN and friends, LOOPOVER_SKIP_NPM_VERSION_CHECK, GITTENSOR_*, LOOPOVER_UPLOAD_SOURCE),
// which the bin reads on every invocation. Only the committed .ts source is imported.
type BinModule = { runCli: (args: string[]) => Promise<number | void> };
type FixtureOptions = NonNullable<Parameters<typeof startFixtureServer>[0]>;

const fixtureOptions: FixtureOptions = {};
let sharedConfigDir = "";
let apiUrl = "";
let mod: BinModule;

beforeAll(async () => {
  sharedConfigDir = mkdtempSync(join(tmpdir(), "loopover-doctor-inprocess-"));
  apiUrl = await startFixtureServer(fixtureOptions);
  // The bin reads these at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_NPM_REGISTRY_URL = apiUrl;
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = sharedConfigDir;
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (sharedConfigDir)
    rmSync(sharedConfigDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_NPM_REGISTRY_URL;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
});

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

/** Set (string) or delete (undefined) env vars around a call, restoring the previous values after —
 *  these are the vars the bin reads at CALL time (not module load), so per-test variation is safe. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function setFixture(overrides: FixtureOptions) {
  Object.assign(fixtureOptions, overrides);
}

describe("loopover-mcp CLI — doctor", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    for (const key of Object.keys(fixtureOptions) as Array<
      keyof FixtureOptions
    >)
      delete fixtureOptions[key];
    rmSync(join(sharedConfigDir, "config.json"), { force: true });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("runs doctor against a local health/session fixture", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    const secretRoot = join(tempDir, "secret-gittensor");
    // configured=true is existsSync(configPath) at call time, so seeding the shared config dir works in-process.
    writeFileSync(
      join(sharedConfigDir, "config.json"),
      JSON.stringify({ apiUrl }),
      { mode: 0o600 },
    );
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          GITTENSOR_ROOT: secretRoot,
          GITTENSOR_SCORE_PREVIEW_CMD: `node ${join(process.cwd(), "test/fixtures/local-scorer/scorer-malformed.mjs")}`,
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        },
        () =>
          captureStdout(() =>
            mod.runCli([
              "doctor",
              "--cwd",
              cwd,
              "--repo",
              "JSONbored/loopover",
              "--json",
            ]),
          ),
      ),
    ) as {
      status: string;
      config: { configured: boolean };
      checklist: Array<{
        id: string;
        title: string;
        status: string;
        checks?: Array<{
          name: string;
          status: string;
          detail: string;
          remediation?: string;
        }>;
      }>;
      nextCommand: { command: string; reason: string };
      checks: Array<{
        name: string;
        status: string;
        detail: string;
        remediation?: string;
      }>;
    };

    const serialized = JSON.stringify(payload);
    expect(payload.status).toMatch(/ok|warnings/);
    expect(serialized).not.toMatch(/secret-gittensor|secret-config/);
    expect(payload.config.configured).toBe(true);
    expect(payload.checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "auth", title: "Auth", status: "pass" }),
        expect.objectContaining({
          id: "api_compatibility",
          title: "API compatibility",
          status: "pass",
        }),
        // Not asserting status here: this group's own "client_path" sub-check (findExecutable("loopover-mcp"))
        // does a plain PATH scan for a "loopover-mcp" executable, which resolves via node_modules/.bin's npm-
        // workspace bin-link -- but npm only creates that symlink if bin/loopover-mcp.js already exists at
        // `npm ci` time. Since compiled output is no longer committed (build(mcp,miner): stop committing
        // compiled .js/.d.ts entirely), every CI job's npm ci runs before any build step, so the symlink is
        // never created there, regardless of a later build -- this group's status is genuinely "warn" in that
        // environment and "pass" only where something else (a real global install, e.g.) already put
        // loopover-mcp on PATH. Checked explicitly below instead, tolerating either.
        expect.objectContaining({
          id: "local_repo_readiness",
          title: "Local repo readiness",
        }),
        expect.objectContaining({
          id: "scorer_availability",
          title: "Scorer availability",
          status: "warn",
        }),
        expect.objectContaining({
          id: "output_safety",
          title: "Output safety",
          status: "pass",
        }),
        expect.objectContaining({
          id: "next_command",
          title: "Next command",
          status: "warn",
        }),
      ]),
    );
    const localRepoReadiness = payload.checklist.find(
      (group) => group.id === "local_repo_readiness",
    );
    expect(["pass", "warn"]).toContain(localRepoReadiness?.status);
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp doctor --json",
      reason: expect.stringContaining("local scorer"),
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "api_health", status: "pass" }),
        expect.objectContaining({
          name: "auth",
          status: "pass",
          detail: expect.stringContaining("JSONbored"),
        }),
        expect.objectContaining({ name: "source_upload", status: "pass" }),
        expect.objectContaining({ name: "git_metadata", status: "pass" }),
        expect.objectContaining({ name: "version", status: "pass" }),
        expect.objectContaining({ name: "api_compatibility", status: "pass" }),
        expect.objectContaining({ name: "local_scorer", status: "warn" }),
        expect.objectContaining({ name: "gittensor_root", status: "pass" }),
      ]),
    );
    const localScorer = payload.checks.find(
      (check) => check.name === "local_scorer",
    );
    expect(localScorer?.detail).toMatch(/malformed_json/);
    expect(localScorer?.detail).not.toMatch(
      join(process.cwd(), "test/fixtures"),
    );
  });

  it("shell-quotes doctor next command values derived from local repo metadata", async () => {
    tempDir = createPacketRepo();
    const cwd = tempDir;
    git(
      tempDir,
      "remote",
      "set-url",
      "origin",
      "git@github.com:owner/repo$(touch /tmp/av_pwned).git",
    );
    const env = {
      LOOPOVER_TOKEN: "session-token",
      GITTENSOR_SCORE_PREVIEW_CMD: `node ${join(process.cwd(), "test/fixtures/local-scorer/scorer-success.mjs")}`,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    const payload = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() => mod.runCli(["doctor", "--cwd", cwd, "--json"])),
      ),
    ) as { nextCommand: { command: string } };
    expect(payload.nextCommand.command).toBe(
      "loopover-mcp review-pr --login JSONbored --repo 'owner/repo$(touch /tmp/av_pwned)' --json",
    );
    expect(payload.nextCommand.command).not.toContain("--repo owner/repo$(");

    const humanOutput = await withEnv(env, () =>
      captureStdout(() => mod.runCli(["doctor", "--cwd", cwd])),
    );
    expect(humanOutput).toContain(
      "loopover-mcp review-pr --login JSONbored --repo 'owner/repo$(touch /tmp/av_pwned)' --json",
    );
    expect(humanOutput).not.toContain("--repo owner/repo$(");
  });

  it("uses doctor as a first-run auth checklist when no local session is configured", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_API_TOKEN: undefined,
          LOOPOVER_TOKEN: undefined,
          LOOPOVER_MCP_TOKEN: undefined,
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        },
        () =>
          captureStdout(() =>
            mod.runCli([
              "doctor",
              "--cwd",
              cwd,
              "--repo",
              "JSONbored/loopover",
              "--json",
            ]),
          ),
      ),
    ) as {
      status: string;
      checklist: Array<{
        id: string;
        status: string;
        checks?: Array<{ name: string; status: string }>;
      }>;
      nextCommand: { command: string; reason: string };
    };

    const auth = payload.checklist.find((group) => group.id === "auth");
    expect(payload.status).toBe("needs_attention");
    expect(auth).toMatchObject({ status: "fail" });
    expect(auth?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "auth", status: "fail" }),
      ]),
    );
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp login --profile default",
      reason: expect.stringContaining("Authenticate"),
    });
    expect(JSON.stringify(payload)).not.toContain(tempDir);
  });

  it("reports a stale global install with an exact upgrade command and npx fallback", async () => {
    setFixture({ latestVersion: "9.9.9" });
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      package: {
        state: string;
        latestVersion: string;
        updateAvailable: boolean;
        upgradeCommand: string;
        npxFallback: string;
      };
    };

    expect(payload.package).toMatchObject({
      state: "stale",
      latestVersion: "9.9.9",
      updateAvailable: true,
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });
    expect(payload.package.npxFallback).toContain("npx @loopover/mcp@latest");
  });

  it("reports a current install without upgrade guidance", async () => {
    setFixture({
      latestVersion: mcpPackageJson.version,
      minMcpVersion: "0.5.0",
    });
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      package: {
        state: string;
        updateAvailable: boolean;
        upgradeCommand?: string;
      };
      apiCompatibility: {
        status: string;
        source: string;
        minVersion: string;
        latestRecommendedVersion: string;
        apiVersion: string;
      };
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
    // Local 0.5.0 (release) vs latest 0.5.0-rc.1 (prerelease) -> local is ahead, not stale.
    setFixture({ latestVersion: "0.5.0-rc.1" });
    const ahead = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as { package: { state: string; updateAvailable: boolean } };
    expect(ahead.package).toMatchObject({
      state: "ahead",
      updateAvailable: false,
    });

    // Local (mcpPackageJson.version) vs a higher-core prerelease (one minor above) -> stale.
    setFixture({ latestVersion: `${oneMinorAboveLocal}-rc.1` });
    const stale = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as { package: { state: string } };
    expect(stale.package.state).toBe("stale");
  });

  it("treats an unavailable npm registry as a warning, not a hard failure", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    setFixture({ npmStatus: 500, compatibilityStatus: 404 });
    const env = {
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
    };
    const status = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      package: { state: string; updateAvailable: boolean };
    };
    expect(status.package.state).toBe("unavailable");
    expect(status.package.updateAvailable).toBe(false);

    const doctor = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() =>
          mod.runCli([
            "doctor",
            "--cwd",
            cwd,
            "--repo",
            "JSONbored/loopover",
            "--json",
          ]),
        ),
      ),
    ) as {
      status: string;
      checks: Array<{ name: string; status: string; remediation?: string }>;
    };
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "version", status: "warn" }),
      ]),
    );
    expect(doctor.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "version", status: "error" }),
      ]),
    );
  });

  it("flags a stale install in doctor with upgrade remediation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    setFixture({ latestVersion: oneMinorAboveLocal });
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () =>
          captureStdout(() =>
            mod.runCli([
              "doctor",
              "--cwd",
              cwd,
              "--repo",
              "JSONbored/loopover",
              "--json",
            ]),
          ),
      ),
    ) as {
      checks: Array<{ name: string; status: string; remediation?: string }>;
    };
    const version = payload.checks.find((check) => check.name === "version");
    expect(version).toMatchObject({ status: "warn" });
    expect(version?.remediation).toContain(
      "npm install -g @loopover/mcp@latest",
    );
    expect(version?.remediation).toContain("npx @loopover/mcp@latest");
  });

  it("reports API compatibility as unavailable when the API does not advertise a minimum version", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    setFixture({ compatibilityStatus: 404 });
    const env = {
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };
    const payload = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      apiCompatibility: { status: string };
    };
    expect(payload.apiCompatibility.status).toBe("unavailable");

    const doctor = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() =>
          mod.runCli([
            "doctor",
            "--cwd",
            cwd,
            "--repo",
            "JSONbored/loopover",
            "--json",
          ]),
        ),
      ),
    ) as { checks: Array<{ name: string; status: string }> };
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "api_compatibility", status: "warn" }),
      ]),
    );
  });

  it("falls back to legacy health compatibility when the endpoint is unavailable", async () => {
    setFixture({ compatibilityStatus: 503, minMcpVersion: "0.4.0" });
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      apiCompatibility: { status: string; source: string; minVersion: string };
    };
    expect(payload.apiCompatibility).toMatchObject({
      status: "compatible",
      source: "health",
      minVersion: "0.4.0",
    });
  });

  it("uses API recommended package metadata when the npm registry is unavailable", async () => {
    setFixture({
      npmStatus: 500,
      latestRecommendedMcpVersion: oneMinorAboveLocal,
    });
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
        },
        () => captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      package: {
        state: string;
        latestStatus: string;
        latestVersion: string;
        upgradeCommand: string;
      };
    };
    expect(payload.package).toMatchObject({
      state: "stale",
      latestStatus: "api",
      latestVersion: oneMinorAboveLocal,
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });
  });

  it("prints API compatibility unknown when the minimum version is unparseable (#6263)", async () => {
    setFixture({ minMcpVersion: "not-a-semver" });
    const env = {
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };
    const statusJson = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      apiCompatibility: { status: string; minVersion: string };
    };
    expect(statusJson.apiCompatibility).toMatchObject({
      status: "unknown",
      minVersion: "not-a-semver",
    });

    // Human-readable status used to omit this arm entirely; keep it visible like doctor().
    const statusOutput = await withEnv(env, () =>
      captureStdout(() => mod.runCli(["status"])),
    );
    expect(statusOutput).toContain("unsupported minimum client version");
    expect(statusOutput).toContain("not-a-semver");
  });

  it("flags API compatibility mismatches with upgrade guidance", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    setFixture({ minMcpVersion: "9.0.0" });
    const env = {
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };
    const status = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() => mod.runCli(["status", "--json"])),
      ),
    ) as {
      apiCompatibility: {
        status: string;
        minVersion: string;
        upgradeCommand: string;
      };
    };
    expect(status.apiCompatibility).toMatchObject({
      status: "incompatible",
      minVersion: "9.0.0",
      upgradeCommand: "npm install -g @loopover/mcp@latest",
    });

    const doctor = JSON.parse(
      await withEnv(env, () =>
        captureStdout(() =>
          mod.runCli([
            "doctor",
            "--cwd",
            cwd,
            "--repo",
            "JSONbored/loopover",
            "--json",
          ]),
        ),
      ),
    ) as {
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
    expect(doctor.checklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api_compatibility", status: "fail" }),
      ]),
    );
    expect(doctor.nextCommand).toMatchObject({
      command: "npm install -g @loopover/mcp@latest",
      reason: expect.stringContaining("Upgrade"),
    });
  });

  it("keeps source upload unsupported and fail-closed in the doctor checklist", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
          LOOPOVER_UPLOAD_SOURCE: "true",
        },
        () =>
          captureStdout(() =>
            mod.runCli([
              "doctor",
              "--cwd",
              cwd,
              "--repo",
              "JSONbored/loopover",
              "--json",
            ]),
          ),
      ),
    ) as {
      sourceUploadSupported: boolean;
      checklist: Array<{
        id: string;
        status: string;
        checks?: Array<{ name: string; status: string; remediation?: string }>;
      }>;
      nextCommand: { command: string; reason: string };
    };

    const outputSafety = payload.checklist.find(
      (group) => group.id === "output_safety",
    );
    expect(payload.sourceUploadSupported).toBe(false);
    expect(outputSafety).toMatchObject({ status: "fail" });
    expect(outputSafety?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_upload", status: "fail" }),
      ]),
    );
    expect(payload.nextCommand).toMatchObject({
      command: "unset LOOPOVER_UPLOAD_SOURCE",
      reason: expect.stringContaining("metadata"),
    });
  });

  it("points missing local repo readiness at an explicit repo-aware doctor command", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    const payload = JSON.parse(
      await withEnv(
        {
          LOOPOVER_TOKEN: "session-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
        },
        () =>
          captureStdout(() => mod.runCli(["doctor", "--cwd", cwd, "--json"])),
      ),
    ) as {
      checklist: Array<{
        id: string;
        status: string;
        checks?: Array<{ name: string; status: string; detail: string }>;
      }>;
      nextCommand: { command: string; reason: string };
    };

    const repoReadiness = payload.checklist.find(
      (group) => group.id === "local_repo_readiness",
    );
    expect(repoReadiness).toMatchObject({ status: "warn" });
    expect(repoReadiness?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "git_metadata", status: "warn" }),
      ]),
    );
    expect(payload.nextCommand).toMatchObject({
      command: "loopover-mcp doctor --repo owner/repo --json",
      reason: expect.stringContaining("git checkout"),
    });
    expect(JSON.stringify(payload)).not.toContain(tempDir);
  });

  it("does not print configured tokens or local absolute paths in status or doctor output", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const cwd = tempDir;
    setFixture({ latestVersion: "9.9.9", minMcpVersion: "9.0.0" });
    const env = {
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_SKIP_NPM_VERSION_CHECK: undefined,
    };
    const statusOutput = await withEnv(env, () =>
      captureStdout(() => mod.runCli(["status"])),
    );
    const statusJsonOutput = await withEnv(env, () =>
      captureStdout(() => mod.runCli(["status", "--json"])),
    );
    const doctorOutput = await withEnv(env, () =>
      captureStdout(() =>
        mod.runCli(["doctor", "--cwd", cwd, "--repo", "JSONbored/loopover"]),
      ),
    );
    const doctorJsonOutput = await withEnv(env, () =>
      captureStdout(() =>
        mod.runCli([
          "doctor",
          "--cwd",
          cwd,
          "--repo",
          "JSONbored/loopover",
          "--json",
        ]),
      ),
    );
    for (const output of [
      statusOutput,
      statusJsonOutput,
      doctorOutput,
      doctorJsonOutput,
    ]) {
      expect(output).not.toContain("session-token");
      expect(output).not.toContain(tempDir);
      expect(output).not.toMatch(/"configPath"/);
    }
    expect(statusOutput).not.toContain("session-token");
    // Sanity: upgrade guidance still surfaces in human-readable output.
    expect(statusOutput).toContain("npm install -g @loopover/mcp@latest");
  });

  it("keeps doctor exit code 0 by default even when a check fails", async () => {
    // No token configured -> the auth check fails -> status "needs_attention".
    let exitCode: number | void = undefined;
    const out = await withEnv(
      {
        LOOPOVER_API_TOKEN: undefined,
        LOOPOVER_TOKEN: undefined,
        LOOPOVER_MCP_TOKEN: undefined,
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      },
      () =>
        captureStdout(async () => {
          exitCode = await mod.runCli(["doctor", "--json"]);
        }),
    );
    const payload = JSON.parse(out) as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };
    expect(exitCode).toBe(0);
    expect(payload.status).toBe("needs_attention");
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "auth", status: "fail" }),
      ]),
    );
  });

  // KEPT as a real subprocess (#8587 rule (a)): the subject is the process exit code itself — the
  // entrypoint's `process.exit(await runCli(...))` wiring, which is unreachable in-process. Reuses the
  // file's shared fixture server (default options) instead of starting a second one.
  it("exits non-zero from doctor --exit-code when a check fails", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    let exitCode = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [bin, "doctor", "--exit-code", "--json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPOVER_API_TIMEOUT_MS: "1000",
          LOOPOVER_API_URL: apiUrl,
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
    expect((JSON.parse(stdout) as { status: string }).status).toBe(
      "needs_attention",
    );
  });

  it("keeps doctor --exit-code at 0 when checks pass", async () => {
    // In-process, the doctor handler RETURNS the would-be exit code; 0 here proves --exit-code stays
    // quiet when checks pass (the original subprocess proved it via runAsync resolving on exit 0).
    let exitCode: number | void = undefined;
    const out = await withEnv(
      {
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
      },
      () =>
        captureStdout(async () => {
          exitCode = await mod.runCli(["doctor", "--exit-code", "--json"]);
        }),
    );
    const payload = JSON.parse(out) as { status: string };
    expect(exitCode).toBe(0);
    expect(payload.status).toMatch(/ok|warnings/);
  });
});
