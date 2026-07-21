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

let originalEnv: NodeJS.ProcessEnv;

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
