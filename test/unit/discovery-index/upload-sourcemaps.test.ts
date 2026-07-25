// Coverage for the discovery-index build's Sentry source-map upload entrypoint (#4934). The module has no
// exports -- it runs `process.exitCode = await main()` as a side effect of being imported (mirroring
// review-enrichment/src/upload-sourcemaps.ts, which is instead tested via subprocess spawn since it lives
// outside Codecov's vitest-measured src/** scope). discovery-index/src/** IS measured here, so this file
// gets real v8 line/branch coverage by re-importing the module in-process per scenario (vi.resetModules() +
// a fresh dynamic import), with node:fs and node:child_process mocked so no real files or processes are
// touched.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "../../../packages/discovery-index/src/upload-sourcemaps";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// upload-sourcemaps.ts derives its own directory from import.meta.url -- since vitest transforms the real
// .ts file in place (no build step), that's genuinely packages/discovery-index/src at test time too.
const DIST_DIR = resolve(TEST_DIR, "../../../packages/discovery-index/src");
const SERVER_JS = resolve(DIST_DIR, "server.js");
const SERVER_MAP = resolve(DIST_DIR, "server.js.map");

const testRequire = createRequire(import.meta.url);
const CLI_PKG_JSON = testRequire.resolve("@sentry/cli/package.json");
const POSTHOG_CLI_PKG_JSON = testRequire.resolve("@posthog/cli/package.json");

const { existsSyncMock, readFileSyncMock, readdirSyncMock, statSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock, readdirSync: readdirSyncMock, statSync: statSyncMock };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const VALID_MAP = JSON.stringify({ sources: ["../src/server.ts"], sourcesContent: ["export const x = 1;"] });
const VALID_BUNDLE = "console.log(1);\n//# sourceMappingURL=server.js.map\n";

type FsFixture = { files: Record<string, string>; dirs: Record<string, string[]> };

function validDistFixture(): FsFixture {
  return {
    files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: VALID_MAP },
    dirs: { [DIST_DIR]: ["server.js", "server.js.map"] },
  };
}

function applyFsFixture({ files, dirs }: FsFixture): void {
  existsSyncMock.mockImplementation((path: string) => path in files);
  readFileSyncMock.mockImplementation((path: string) => {
    if (!(path in files)) throw new Error(`ENOENT (fixture): ${path}`);
    return files[path];
  });
  readdirSyncMock.mockImplementation((dir: string) => {
    const children = dirs[dir] ?? [];
    return children.map((name) => ({ name, isDirectory: () => Array.isArray(dirs[resolve(dir, name)]) }));
  });
  statSyncMock.mockImplementation(() => ({ isFile: () => true }));
}

const REQUIRED_ENV: Record<string, string> = {
  SENTRY_CLI_PATH: "FAKE_SENTRY_CLI",
  SENTRY_AUTH_TOKEN: "test-token",
  SENTRY_ORG: "jsonbored",
  SENTRY_PROJECT: "discovery-index",
  SENTRY_RELEASE: "loopover-discovery-index@abc123",
  DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "0",
};

// PostHog leg's own required config (#8289) -- NOT included in REQUIRED_ENV above, so every existing Sentry-
// only test in this file exercises the PostHog leg's missing-config skip path (contributing exit code 0 to
// main()'s Math.max combine) without needing any changes.
const POSTHOG_REQUIRED_ENV: Record<string, string> = {
  POSTHOG_CLI_PATH: "FAKE_POSTHOG_CLI",
  POSTHOG_CLI_API_KEY: "phx_test_personal_key",
  POSTHOG_CLI_PROJECT_ID: "12345",
  POSTHOG_RELEASE: "loopover-discovery-index@abc123",
};

let originalEnv: NodeJS.ProcessEnv;

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Sets both legs' required env (Sentry's REQUIRED_ENV + PostHog's POSTHOG_REQUIRED_ENV), so a test can
 *  exercise the PostHog leg's real behavior alongside the (unchanged, default-successful) Sentry leg. */
function setEnvWithPostHog(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...POSTHOG_REQUIRED_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isPostHogCliCall(command: string): boolean {
  return command === "FAKE_POSTHOG_CLI";
}

function isPostHogValidateReleaseCall(args: string[]): boolean {
  return args[0] === "scripts/validate-posthog-release.mjs";
}

function spawnSuccess(): { status: number; stdout: string; stderr: string } {
  return { status: 0, stdout: "", stderr: "" };
}

function isValidateReleaseCall(args: string[]): boolean {
  return args[0] === "scripts/validate-sentry-release.mjs";
}

async function run(): Promise<void> {
  await import(MODULE_PATH);
}

beforeEach(() => {
  originalEnv = { ...process.env };
  vi.resetModules();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  readdirSyncMock.mockReset();
  statSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(spawnSuccess);
  applyFsFixture(validDistFixture());
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.restoreAllMocks();
});

describe("discovery-index upload-sourcemaps (#4934)", () => {
  it("skips the upload and exits 0 when required Sentry config is missing", async () => {
    setEnv({ SENTRY_AUTH_TOKEN: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("runs the full success flow with no sha and validation turned off", async () => {
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    const calls = spawnSyncMock.mock.calls.map(([command, args]) => ({ command, args }));
    expect(calls).toEqual([
      { command: "FAKE_SENTRY_CLI", args: ["releases", "--org", "jsonbored", "--project", "discovery-index", "new", "loopover-discovery-index@abc123"] },
      { command: "FAKE_SENTRY_CLI", args: ["sourcemaps", "--org", "jsonbored", "--project", "discovery-index", "inject", "dist"] },
      {
        command: "FAKE_SENTRY_CLI",
        args: ["sourcemaps", "--org", "jsonbored", "--project", "discovery-index", "upload", "--release", "loopover-discovery-index@abc123", "--validate", "--wait", "dist"],
      },
      { command: "FAKE_SENTRY_CLI", args: ["releases", "--org", "jsonbored", "--project", "discovery-index", "deploys", "new", "--release", "loopover-discovery-index@abc123", "--env", "production", "--name", "cloudflare-container"] },
      { command: "FAKE_SENTRY_CLI", args: ["releases", "--org", "jsonbored", "--project", "discovery-index", "finalize", "loopover-discovery-index@abc123"] },
    ]);
    // No sha at all -> set-commits is skipped entirely; validation is off -> its script is never spawned.
    expect(calls.some((call) => call.args.includes("set-commits"))).toBe(false);
    expect(calls.some((call) => isValidateReleaseCall(call.args))).toBe(false);
  });

  it("associates commits via set-commits using the default repo when only a commit sha is given", async () => {
    setEnv({ SENTRY_COMMIT_SHA: "abc123" });
    await run();
    expect(process.exitCode).toBe(0);
    const setCommits = spawnSyncMock.mock.calls.find(([, args]) => args.includes("set-commits"));
    expect(setCommits?.[1]).toEqual([
      "releases",
      "--org",
      "jsonbored",
      "--project",
      "discovery-index",
      "set-commits",
      "loopover-discovery-index@abc123",
      "--commit",
      "JSONbored/loopover@abc123",
      "--ignore-missing",
    ]);
  });

  it("uses a commit range and a custom repo when a previous sha and SENTRY_REPOSITORY are both given", async () => {
    setEnv({ SENTRY_COMMIT_SHA: "def456", SENTRY_PREVIOUS_COMMIT_SHA: "abc123", SENTRY_REPOSITORY: "acme/other-repo" });
    await run();
    expect(process.exitCode).toBe(0);
    const setCommits = spawnSyncMock.mock.calls.find(([, args]) => args.includes("set-commits"));
    expect(setCommits?.[1]).toContain("acme/other-repo@abc123..def456");
  });

  it("treats a 'release already exists' failure on the create step as success (allowExistingRelease)", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (args[0] === "releases" && args.includes("new")) return { status: 1, stdout: "", stderr: "410: version already exists" };
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
  });

  it("swallows a failed non-strict set-commits with a warning and continues the upload", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (args.includes("set-commits")) return { status: 1, stdout: "", stderr: "unrelated commit history" };
      return spawnSuccess();
    });
    setEnv({ SENTRY_COMMIT_SHA: "abc123" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_cli_failed"));
    // Non-strict allowFailure means the upload still proceeds past set-commits to finalize.
    expect(spawnSyncMock.mock.calls.some(([, args]) => args.includes("finalize"))).toBe(true);
  });

  it("propagates a failed strict set-commits as a hard failure and exits 1", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (args.includes("set-commits")) return { status: 1, stdout: "", stderr: "unrelated commit history" };
      return spawnSuccess();
    });
    setEnv({ SENTRY_COMMIT_SHA: "abc123", DISCOVERY_INDEX_SENTRY_UPLOAD_STRICT: "true" });
    await run();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_sourcemap_upload_failed"));
  });

  it("fails non-strict validateSourceMaps errors as a soft failure (exit 0) with the reason logged", async () => {
    applyFsFixture({ files: { [SERVER_MAP]: VALID_MAP }, dirs: { [DIST_DIR]: ["server.js.map"] } });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dist/server.js is missing"));
  });

  it("throws when dist/server.js.map is missing", async () => {
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE }, dirs: { [DIST_DIR]: ["server.js"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dist/server.js.map is missing"));
  });

  it("throws when the server bundle is missing its sourceMappingURL comment", async () => {
    applyFsFixture({ files: { [SERVER_JS]: "console.log(1);\n", [SERVER_MAP]: VALID_MAP }, dirs: { [DIST_DIR]: ["server.js", "server.js.map"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("missing the server.js.map sourceMappingURL"));
  });

  it("throws when no .js.map files are found even though the required files exist", async () => {
    // existsSync reports both files present, but the directory listing (a separate mock) omits the map --
    // exercises the maps.length === 0 branch independently of the existsSync checks above it.
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: VALID_MAP }, dirs: { [DIST_DIR]: ["server.js"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("dist has no JavaScript source maps"));
  });

  it("throws when a source map has no original sources", async () => {
    const badMap = JSON.stringify({ sources: [], sourcesContent: [] });
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: badMap }, dirs: { [DIST_DIR]: ["server.js", "server.js.map"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("has no original sources"));
  });

  it("throws when a source map's sourcesContent doesn't match its sources length", async () => {
    const badMap = JSON.stringify({ sources: ["../src/server.ts"], sourcesContent: [] });
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: badMap }, dirs: { [DIST_DIR]: ["server.js", "server.js.map"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("does not embed sourcesContent for every source"));
  });

  it("throws when a source map's sourcesContent is present but entirely blank", async () => {
    const badMap = JSON.stringify({ sources: ["../src/server.ts"], sourcesContent: ["   "] });
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: badMap }, dirs: { [DIST_DIR]: ["server.js", "server.js.map"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("has empty sourcesContent"));
  });

  it("throws when no source map references src/server.ts", async () => {
    const badMap = JSON.stringify({ sources: ["../src/other.ts"], sourcesContent: ["export const y = 1;"] });
    applyFsFixture({ files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: badMap }, dirs: { [DIST_DIR]: ["server.js", "server.js.map"] } });
    setEnv({});
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("source maps do not include src/server.ts"));
  });

  it("recurses into nested directories when scanning dist for source maps", async () => {
    const chunkDir = resolve(DIST_DIR, "chunks");
    const chunkMap = JSON.stringify({ sources: ["../src/other.ts"], sourcesContent: ["export const z = 1;"] });
    applyFsFixture({
      files: { [SERVER_JS]: VALID_BUNDLE, [SERVER_MAP]: VALID_MAP, [resolve(chunkDir, "chunk1.js.map")]: chunkMap },
      dirs: { [DIST_DIR]: ["server.js", "server.js.map", "chunks"], [chunkDir]: ["chunk1.js.map"] },
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
  });

  it("resolves the real sentry-cli binary from a string-form package.json bin field", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [CLI_PKG_JSON]: JSON.stringify({ bin: "bin/sentry-cli" }) },
    });
    setEnv({ SENTRY_CLI_PATH: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    const [command] = spawnSyncMock.mock.calls[0] ?? [];
    expect(command).toBe(resolve(dirname(CLI_PKG_JSON), "bin/sentry-cli"));
  });

  it("falls back to an '@sentry/cli'-keyed bin field when 'sentry-cli' isn't present", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [CLI_PKG_JSON]: JSON.stringify({ bin: { "@sentry/cli": "bin/alt-cli" } }) },
    });
    setEnv({ SENTRY_CLI_PATH: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    const [command] = spawnSyncMock.mock.calls[0] ?? [];
    expect(command).toBe(resolve(dirname(CLI_PKG_JSON), "bin/alt-cli"));
  });

  it("fails when @sentry/cli's package.json has no resolvable bin entry", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [CLI_PKG_JSON]: JSON.stringify({}) },
    });
    setEnv({ SENTRY_CLI_PATH: undefined });
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no resolvable bin entry"));
  });

  it("skips release validation entirely when DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE is off", async () => {
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "0" });
    await run();
    expect(spawnSyncMock.mock.calls.some(([, args]) => isValidateReleaseCall(args))).toBe(false);
  });

  it("runs release validation once and succeeds on the first attempt", async () => {
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1" });
    await run();
    expect(process.exitCode).toBe(0);
    const validateCalls = spawnSyncMock.mock.calls.filter(([, args]) => isValidateReleaseCall(args));
    expect(validateCalls).toHaveLength(1);
  });

  it("retries release validation until it succeeds, logging a retry warning each time", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isValidateReleaseCall(args)) {
        validateAttempts += 1;
        return validateAttempts < 3 ? { status: 1, stdout: "", stderr: "release not fully propagated yet" } : spawnSuccess();
      }
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS: "5", DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(validateAttempts).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_release_validation_retry"));
  });

  it("falls back to the default attempt count when DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS is invalid", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isValidateReleaseCall(args)) {
        validateAttempts += 1;
        return { status: 1, stdout: "", stderr: "still not visible" };
      }
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS: "not-a-number", DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    // Non-strict: exhausting all attempts is caught by main() and treated as a soft failure.
    expect(validateAttempts).toBe(5);
  });

  it("clamps an oversized DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS to its max of 20", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isValidateReleaseCall(args)) {
        validateAttempts += 1;
        return { status: 1, stdout: "", stderr: "still not visible" };
      }
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS: "999", DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(validateAttempts).toBe(20);
  });

  it("tolerates a spawnSync result missing stdout/stderr, and logs verbose output on success", async () => {
    let call = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      call += 1;
      // No stdout/stderr keys at all -> exercises the `result.stdout ?? ""` / `result.stderr ?? ""`
      // fallback used to build runSentry's `output` string.
      if (call === 1) return { status: 0 };
      if (call === 2) return { status: 0, stdout: "uploaded 3 files" };
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_cli"));
  });

  it("defaults release validation to ON when DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE is unset", async () => {
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock.mock.calls.some(([, args]) => isValidateReleaseCall(args))).toBe(true);
  });

  it("logs verbose release-validation output, waits between retries, and tolerates a missing stdout/stderr result", async () => {
    let attempt = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (!isValidateReleaseCall(args)) return spawnSuccess();
      attempt += 1;
      // First attempt fails with no stdout/stderr keys (the ?? "" fallback); second succeeds with real
      // output (the `if (output) log(...)` truthy branch).
      if (attempt === 1) return { status: 1 };
      return { status: 0, stdout: "release visible" };
    });
    setEnv({ DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS: "3", DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS: "5" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(attempt).toBe(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_release_validation"));
  });

  it("handles a non-Error value thrown out of spawnSync as a soft failure", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (args[0] === "releases" && args.includes("new")) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch deliberately
        throw "spawnSync exploded (string throw)";
      }
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("spawnSync exploded (string throw)"));
  });

  it("exhausts validation attempts and fails strictly (exit 1) when set to strict", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isValidateReleaseCall(args)) return { status: 1, stdout: "", stderr: "still not visible" };
      return spawnSuccess();
    });
    setEnv({
      DISCOVERY_INDEX_SENTRY_VALIDATE_RELEASE: "1",
      DISCOVERY_INDEX_SENTRY_VALIDATE_ATTEMPTS: "2",
      DISCOVERY_INDEX_SENTRY_VALIDATE_RETRY_DELAY_MS: "0",
      DISCOVERY_INDEX_SENTRY_UPLOAD_STRICT: "true",
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_sentry_sourcemap_upload_failed"));
  });
});

describe("discovery-index upload-sourcemaps -- PostHog leg (#8289)", () => {
  it("skips the PostHog upload and exits 0 when required PostHog config is missing (Sentry leg still runs)", async () => {
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock.mock.calls.some(([command]) => isPostHogCliCall(command))).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_skipped"));
  });

  it("runs the full PostHog success flow with the exact inject/upload args, after the Sentry leg", async () => {
    setEnvWithPostHog({});
    await run();
    expect(process.exitCode).toBe(0);
    const posthogCalls = spawnSyncMock.mock.calls.filter(([command]) => isPostHogCliCall(command)).map(([, args]) => args);
    expect(posthogCalls).toEqual([
      ["sourcemap", "inject", "--directory", "dist", "--release-version", "loopover-discovery-index@abc123"],
      ["sourcemap", "upload", "--directory", "dist", "--release-version", "loopover-discovery-index@abc123"],
    ]);
    // Sentry's own calls are unaffected -- both legs' spawnSync calls coexist in the same mock's call list.
    expect(spawnSyncMock.mock.calls.some(([command]) => command === "FAKE_SENTRY_CLI")).toBe(true);
  });

  it("treats a non-strict PostHog upload failure as a soft failure (exit 0) with the reason logged", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[1] === "upload") return { status: 1, stdout: "", stderr: "upload rejected" };
      return spawnSuccess();
    });
    setEnvWithPostHog({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_failed"));
  });

  it("propagates a strict PostHog upload failure as exit 1, even when the Sentry leg succeeds", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[1] === "upload") return { status: 1, stdout: "", stderr: "upload rejected" };
      return spawnSuccess();
    });
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT: "true" });
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("still runs (and can fail) the PostHog leg even when the Sentry leg fails strictly -- both legs are independent", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (args.includes("set-commits")) return { status: 1, stdout: "", stderr: "unrelated commit history" };
      return spawnSuccess();
    });
    setEnvWithPostHog({ SENTRY_COMMIT_SHA: "abc123", DISCOVERY_INDEX_SENTRY_UPLOAD_STRICT: "true" });
    await run();
    expect(process.exitCode).toBe(1);
    expect(spawnSyncMock.mock.calls.some(([command]) => isPostHogCliCall(command))).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_complete"));
  });

  it("handles a non-Error value thrown out of the PostHog spawnSync as a soft failure", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[0] === "sourcemap" && args[1] === "inject") {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch deliberately
        throw "spawnSync exploded (string throw)";
      }
      return spawnSuccess();
    });
    setEnvWithPostHog({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("spawnSync exploded (string throw)"));
  });

  it("resolves the real posthog-cli binary from its package.json bin field", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [POSTHOG_CLI_PKG_JSON]: JSON.stringify({ bin: { "posthog-cli": "run-posthog-cli.js" } }) },
    });
    setEnvWithPostHog({ POSTHOG_CLI_PATH: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    const posthogCall = spawnSyncMock.mock.calls.find(([, args]) => args[0] === "sourcemap");
    expect(posthogCall?.[0]).toBe(resolve(dirname(POSTHOG_CLI_PKG_JSON), "run-posthog-cli.js"));
  });

  it("falls back to an '@posthog/cli'-keyed bin field when 'posthog-cli' isn't present", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [POSTHOG_CLI_PKG_JSON]: JSON.stringify({ bin: { "@posthog/cli": "bin/alt-cli" } }) },
    });
    setEnvWithPostHog({ POSTHOG_CLI_PATH: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    const posthogCall = spawnSyncMock.mock.calls.find(([, args]) => args[0] === "sourcemap");
    expect(posthogCall?.[0]).toBe(resolve(dirname(POSTHOG_CLI_PKG_JSON), "bin/alt-cli"));
  });

  it("resolves a string-form package.json bin field", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [POSTHOG_CLI_PKG_JSON]: JSON.stringify({ bin: "run-posthog-cli.js" }) },
    });
    setEnvWithPostHog({ POSTHOG_CLI_PATH: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    const posthogCall = spawnSyncMock.mock.calls.find(([, args]) => args[0] === "sourcemap");
    expect(posthogCall?.[0]).toBe(resolve(dirname(POSTHOG_CLI_PKG_JSON), "run-posthog-cli.js"));
  });

  it("fails when @posthog/cli's package.json has no resolvable bin entry", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [POSTHOG_CLI_PKG_JSON]: JSON.stringify({}) },
    });
    setEnvWithPostHog({ POSTHOG_CLI_PATH: undefined });
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no resolvable bin entry"));
  });

  it("tolerates a posthog-cli spawnSync result missing stdout/stderr", async () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (isPostHogCliCall(command)) return { status: 0 };
      return spawnSuccess();
    });
    setEnvWithPostHog({});
    await run();
    expect(process.exitCode).toBe(0);
  });

  it("logs verbose posthog-cli output on success", async () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (isPostHogCliCall(command)) return { status: 0, stdout: "uploaded 3 sourcemaps" };
      return spawnSuccess();
    });
    setEnvWithPostHog({});
    await run();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_cli"));
  });

  it("skips PostHog release validation entirely when DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE is off", async () => {
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "0" });
    await run();
    expect(spawnSyncMock.mock.calls.some(([, args]) => isPostHogValidateReleaseCall(args))).toBe(false);
  });

  it("defaults PostHog release validation to ON when DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE is unset", async () => {
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock.mock.calls.some(([, args]) => isPostHogValidateReleaseCall(args))).toBe(true);
  });

  it("retries PostHog release validation until it succeeds, logging a retry warning each time", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) {
        validateAttempts += 1;
        return validateAttempts < 3 ? { status: 1, stdout: "", stderr: "release not fully propagated yet" } : { status: 0, stdout: "release visible" };
      }
      return spawnSuccess();
    });
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "5", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(validateAttempts).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_release_validation_retry"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_release_validation"));
  });

  it("tolerates a PostHog validate-release result missing stdout/stderr, and waits between retries", async () => {
    let attempt = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (!isPostHogValidateReleaseCall(args)) return spawnSuccess();
      attempt += 1;
      if (attempt === 1) return { status: 1 };
      return { status: 0, stdout: "release visible" };
    });
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "3", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "5" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(attempt).toBe(2);
  });

  it("exhausts PostHog validation attempts and fails softly (exit 0) when not strict", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) return { status: 1, stdout: "", stderr: "still not visible" };
      return spawnSuccess();
    });
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "2", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_failed"));
  });

  it("exhausts PostHog validation attempts and fails strictly (exit 1) when set to strict", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) return { status: 1, stdout: "", stderr: "still not visible" };
      return spawnSuccess();
    });
    setEnvWithPostHog({
      DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "2",
      DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0",
      DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT: "true",
    });
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("clamps an oversized DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS to its max of 20", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) {
        validateAttempts += 1;
        return { status: 1, stdout: "", stderr: "still not visible" };
      }
      return spawnSuccess();
    });
    setEnvWithPostHog({ DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "999", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(validateAttempts).toBe(20);
  });

  it("re-validates source maps between inject and upload, failing the PostHog leg if injection corrupted them", async () => {
    let injected = false;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[1] === "inject") {
        injected = true;
        return spawnSuccess();
      }
      return spawnSuccess();
    });
    readFileSyncMock.mockImplementation((path: string) => {
      if (injected && path === SERVER_MAP) return JSON.stringify({ sources: [], sourcesContent: [] });
      const fixture = validDistFixture().files;
      if (!(path in fixture)) throw new Error(`ENOENT (fixture): ${path}`);
      return fixture[path];
    });
    setEnvWithPostHog({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("has no original sources"));
  });
});
