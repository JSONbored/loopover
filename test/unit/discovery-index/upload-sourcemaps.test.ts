// Coverage for the discovery-index build's PostHog source-map upload entrypoint (#8289). REPLACES the old
// Sentry-based entrypoint entirely (epic #8286's 2026-07-25 strategy correction) -- there is no more Sentry
// leg to test here. The module has no exports -- it runs `process.exitCode = await main()` as a side effect
// of being imported (mirroring review-enrichment/src/upload-sourcemaps.ts, which is instead tested via
// subprocess spawn since it lives outside Codecov's vitest-measured src/** scope). discovery-index/src/** IS
// measured here, so this file gets real v8 line/branch coverage by re-importing the module in-process per
// scenario (vi.resetModules() + a fresh dynamic import), with node:fs and node:child_process mocked so no
// real files or processes are touched.
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
  POSTHOG_CLI_PATH: "FAKE_POSTHOG_CLI",
  POSTHOG_CLI_API_KEY: "phx_test_personal_key",
  POSTHOG_CLI_PROJECT_ID: "12345",
  POSTHOG_RELEASE: "loopover-discovery-index@abc123",
  DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "0",
};

let originalEnv: NodeJS.ProcessEnv;

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
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

describe("discovery-index upload-sourcemaps -- PostHog (#8289)", () => {
  it("skips the upload and exits 0 when required PostHog config is missing", async () => {
    setEnv({ POSTHOG_CLI_API_KEY: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_skipped"));
  });

  it("runs the full success flow with the exact inject/upload args", async () => {
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    const posthogCalls = spawnSyncMock.mock.calls.filter(([command]) => isPostHogCliCall(command)).map(([, args]) => args);
    expect(posthogCalls).toEqual([
      ["sourcemap", "inject", "--directory", "dist", "--release-version", "loopover-discovery-index@abc123"],
      ["sourcemap", "upload", "--directory", "dist", "--release-version", "loopover-discovery-index@abc123"],
    ]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_complete"));
  });

  it("treats a non-strict upload failure as a soft failure (exit 0) with the reason logged", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[1] === "upload") return { status: 1, stdout: "", stderr: "upload rejected" };
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_failed"));
  });

  it("propagates a strict upload failure as exit 1", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[1] === "upload") return { status: 1, stdout: "", stderr: "upload rejected" };
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT: "true" });
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("handles a non-Error value thrown out of spawnSync as a soft failure", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogCliCall(command) && args[0] === "sourcemap" && args[1] === "inject") {
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

  it("resolves the real posthog-cli binary from its package.json bin field", async () => {
    applyFsFixture({
      ...validDistFixture(),
      files: { ...validDistFixture().files, [POSTHOG_CLI_PKG_JSON]: JSON.stringify({ bin: { "posthog-cli": "run-posthog-cli.js" } }) },
    });
    setEnv({ POSTHOG_CLI_PATH: undefined });
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
    setEnv({ POSTHOG_CLI_PATH: undefined });
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
    setEnv({ POSTHOG_CLI_PATH: undefined });
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
    setEnv({ POSTHOG_CLI_PATH: undefined });
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no resolvable bin entry"));
  });

  it("tolerates a posthog-cli spawnSync result missing stdout/stderr", async () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (isPostHogCliCall(command)) return { status: 0 };
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
  });

  it("logs verbose posthog-cli output on success", async () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (isPostHogCliCall(command)) return { status: 0, stdout: "uploaded 3 sourcemaps" };
      return spawnSuccess();
    });
    setEnv({});
    await run();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_cli"));
  });

  it("skips release validation entirely when DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE is off", async () => {
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "0" });
    await run();
    expect(spawnSyncMock.mock.calls.some(([, args]) => isPostHogValidateReleaseCall(args))).toBe(false);
  });

  it("defaults release validation to ON when DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE is unset", async () => {
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: undefined });
    await run();
    expect(process.exitCode).toBe(0);
    expect(spawnSyncMock.mock.calls.some(([, args]) => isPostHogValidateReleaseCall(args))).toBe(true);
  });

  it("retries release validation until it succeeds, logging a retry warning each time", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) {
        validateAttempts += 1;
        return validateAttempts < 3 ? { status: 1, stdout: "", stderr: "release not fully propagated yet" } : { status: 0, stdout: "release visible" };
      }
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "5", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(validateAttempts).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_release_validation_retry"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_release_validation"));
  });

  it("falls back to the default attempt count when DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS is invalid", async () => {
    let validateAttempts = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) {
        validateAttempts += 1;
        return { status: 1, stdout: "", stderr: "still not visible" };
      }
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "not-a-number", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    // Non-strict: exhausting all attempts is caught and treated as a soft failure.
    expect(validateAttempts).toBe(5);
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
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "999", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(validateAttempts).toBe(20);
  });

  it("tolerates a validate-release result missing stdout/stderr, and waits between retries", async () => {
    let attempt = 0;
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (!isPostHogValidateReleaseCall(args)) return spawnSuccess();
      attempt += 1;
      if (attempt === 1) return { status: 1 };
      return { status: 0, stdout: "release visible" };
    });
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "3", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "5" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(attempt).toBe(2);
  });

  it("exhausts validation attempts and fails softly (exit 0) when not strict", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) return { status: 1, stdout: "", stderr: "still not visible" };
      return spawnSuccess();
    });
    setEnv({ DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1", DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "2", DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0" });
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_failed"));
  });

  it("exhausts validation attempts and fails strictly (exit 1) when set to strict", async () => {
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (isPostHogValidateReleaseCall(args)) return { status: 1, stdout: "", stderr: "still not visible" };
      return spawnSuccess();
    });
    setEnv({
      DISCOVERY_INDEX_POSTHOG_VALIDATE_RELEASE: "1",
      DISCOVERY_INDEX_POSTHOG_VALIDATE_ATTEMPTS: "2",
      DISCOVERY_INDEX_POSTHOG_VALIDATE_RETRY_DELAY_MS: "0",
      DISCOVERY_INDEX_POSTHOG_UPLOAD_STRICT: "true",
    });
    await run();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("discovery_index_posthog_sourcemap_upload_failed"));
  });

  it("re-validates source maps between inject and upload, failing the leg if injection corrupted them", async () => {
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
    setEnv({});
    await run();
    expect(process.exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("has no original sources"));
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
});
