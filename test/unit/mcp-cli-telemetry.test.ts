import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
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
  closeFixtureServer,
  run,
  runAsync,
  runExpectingFailure,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #6239: local MCP usage telemetry is opt-in and defaults OFF (per #6228's privacy decision). The opt-in is
// a top-level `telemetryEnabled` flag persisted in the same config file `login` uses, and status/doctor/config
// surface the current state. These tests exercise both the default-off state and the enable/disable toggle.

// #8587: most of this file KEEPS real subprocesses on purpose (rule (d)): the bin loads its config file ONCE
// at module import (`const config = loadConfig()`), and `telemetry status` / `status` / `doctor` / `config`
// all report that import-time snapshot. Every scenario that toggles the opt-in and then re-reads it through a
// later invocation therefore genuinely depends on fresh-process config loading — in-process, the re-read
// would keep reporting the stale snapshot (and `telemetry enable` would clobber a session `login` just wrote,
// since it merges into the import-time config). Only the malformed-persisted-value case converts: its config
// file is seeded BEFORE the module import, exactly mirroring a spawned process parsing it at startup.
type BinModule = { runCli: (args: string[]) => Promise<number | void> };

let inProcessConfigDir = "";
let mod: BinModule;

beforeAll(async () => {
  inProcessConfigDir = mkdtempSync(
    join(tmpdir(), "loopover-telemetry-inprocess-"),
  );
  // A non-boolean (legacy/hand-edited) value must not be read as an opt-in; written before the import so the
  // bin's load-time config parse sees it, like a spawned CLI would at startup.
  writeFileSync(
    join(inProcessConfigDir, "config.json"),
    JSON.stringify({ telemetryEnabled: "true", profiles: {} }),
    { mode: 0o600 },
  );
  // Inert API URL: the converted case never calls the API, but the bin resolves this at module load.
  process.env.LOOPOVER_API_URL = "http://127.0.0.1:9";
  process.env.LOOPOVER_CONFIG_DIR = inProcessConfigDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(() => {
  if (inProcessConfigDir)
    rmSync(inProcessConfigDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
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
describe("loopover-mcp CLI — telemetry opt-in", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("defaults telemetry to off and persists an explicit opt-in across CLI invocations", () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const configPath = join(tempDir, "config.json");
    const env = {
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    // Default: nothing configured -> disabled, and status alone never writes a config file.
    const before = JSON.parse(run(["telemetry", "status", "--json"], env)) as {
      telemetry: { enabled: boolean; default: boolean };
    };
    expect(before.telemetry).toEqual({ enabled: false, default: false });
    expect(existsSync(configPath)).toBe(false);

    // Enabling persists the flag to disk...
    const enabled = JSON.parse(run(["telemetry", "enable", "--json"], env)) as {
      status: string;
      telemetry: { enabled: boolean };
    };
    expect(enabled).toMatchObject({
      status: "telemetry_enabled",
      telemetry: { enabled: true, default: false },
    });
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
      telemetryEnabled?: boolean;
    };
    expect(saved.telemetryEnabled).toBe(true);

    // ...so a *fresh* process (new invocation) reads the opt-in back as enabled.
    const persisted = JSON.parse(
      run(["telemetry", "status", "--json"], env),
    ) as { telemetry: { enabled: boolean } };
    expect(persisted.telemetry.enabled).toBe(true);

    // Disabling clears the flag; with no other durable state, the config file is removed entirely
    // (rather than left holding `telemetryEnabled: false`).
    const disabled = JSON.parse(
      run(["telemetry", "disable", "--json"], env),
    ) as { status: string; telemetry: { enabled: boolean } };
    expect(disabled).toMatchObject({
      status: "telemetry_disabled",
      telemetry: { enabled: false },
    });
    expect(existsSync(configPath)).toBe(false);
    const afterDisable = JSON.parse(
      run(["telemetry", "status", "--json"], env),
    ) as { telemetry: { enabled: boolean } };
    expect(afterDisable.telemetry.enabled).toBe(false);
  });

  it("prints human-readable telemetry state and toggles", () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const env = {
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    expect(run(["telemetry", "enable"], env)).toContain(
      "Local MCP usage telemetry enabled.",
    );
    expect(run(["telemetry", "status"], env)).toContain(
      "Telemetry: enabled (opt-in)",
    );
    expect(run(["telemetry", "disable"], env)).toContain(
      "Local MCP usage telemetry disabled.",
    );
    // A bare `telemetry` invocation defaults to the status view.
    expect(run(["telemetry"], env)).toContain("Telemetry: disabled (default)");
  });

  it("reports the current opt-in state through status, doctor, and config", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    // Default-off surfaces everywhere.
    const statusOff = JSON.parse(await runAsync(["status", "--json"], env)) as {
      telemetry: { enabled: boolean };
    };
    const configOff = JSON.parse(await runAsync(["config", "--json"], env)) as {
      telemetry: { enabled: boolean };
    };
    const doctorOff = JSON.parse(
      await runAsync(
        ["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"],
        env,
      ),
    ) as {
      telemetry: { enabled: boolean };
      checklist: Array<{
        id: string;
        checks?: Array<{ name: string; status: string }>;
      }>;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(statusOff.telemetry.enabled).toBe(false);
    expect(configOff.telemetry.enabled).toBe(false);
    expect(doctorOff.telemetry.enabled).toBe(false);
    // The telemetry check is a pass that lives under the Output safety group and states the default.
    expect(doctorOff.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telemetry",
          status: "pass",
          detail: expect.stringContaining("disabled (default)"),
        }),
      ]),
    );
    const outputSafetyOff = doctorOff.checklist.find(
      (group) => group.id === "output_safety",
    );
    expect(outputSafetyOff?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telemetry", status: "pass" }),
      ]),
    );

    // After an explicit opt-in, every reporter reflects it.
    await runAsync(["telemetry", "enable", "--json"], env);
    const statusOn = JSON.parse(await runAsync(["status", "--json"], env)) as {
      telemetry: { enabled: boolean };
    };
    const configOn = JSON.parse(await runAsync(["config", "--json"], env)) as {
      telemetry: { enabled: boolean };
    };
    const doctorOn = JSON.parse(
      await runAsync(
        ["doctor", "--cwd", tempDir, "--repo", "JSONbored/loopover", "--json"],
        env,
      ),
    ) as {
      telemetry: { enabled: boolean };
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(statusOn.telemetry.enabled).toBe(true);
    expect(configOn.telemetry.enabled).toBe(true);
    expect(doctorOn.telemetry.enabled).toBe(true);
    expect(doctorOn.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telemetry",
          status: "pass",
          detail: expect.stringContaining("enabled (opt-in)"),
        }),
      ]),
    );

    // Human-readable status and config lines mention the state too.
    const statusHuman = await runAsync(["status"], env);
    const configHuman = await runAsync(["config"], env);
    expect(statusHuman).toContain("Telemetry: enabled (opt-in)");
    expect(configHuman).toContain("Telemetry: enabled (opt-in)");
  });

  it("keeps an authenticated profile intact when telemetry is toggled", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const configPath = join(tempDir, "config.json");
    const url = await startFixtureServer();
    const env = {
      LOOPOVER_API_URL: url,
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    await runAsync(
      [
        "login",
        "--profile",
        "jsonbored",
        "--github-token",
        "github-jsonbored",
        "--json",
      ],
      env,
    );
    const enabled = JSON.parse(
      await runAsync(["telemetry", "enable", "--json"], env),
    ) as { telemetry: { enabled: boolean } };
    expect(enabled.telemetry.enabled).toBe(true);

    // The opt-in persists alongside the existing session, without clobbering it.
    const savedAfterEnable = JSON.parse(readFileSync(configPath, "utf8")) as {
      telemetryEnabled?: boolean;
      profiles?: Record<string, { session?: { login?: string } }>;
    };
    expect(savedAfterEnable.telemetryEnabled).toBe(true);
    expect(savedAfterEnable.profiles?.jsonbored?.session?.login).toBe(
      "JSONbored",
    );

    // Disabling telemetry clears only the flag; the authenticated profile survives, so the file stays.
    await runAsync(["telemetry", "disable", "--json"], env);
    const savedAfterDisable = JSON.parse(readFileSync(configPath, "utf8")) as {
      telemetryEnabled?: boolean;
      profiles?: Record<string, { session?: { login?: string } }>;
    };
    expect(savedAfterDisable.telemetryEnabled).toBeUndefined();
    expect(savedAfterDisable.profiles?.jsonbored?.session?.login).toBe(
      "JSONbored",
    );
    // Telemetry output never leaks the persisted session token or the temp path.
    expect(JSON.stringify({ enabled })).not.toMatch(
      /session-jsonbored|github-jsonbored|loopover-cli-/,
    );
  });

  it("treats a malformed persisted telemetryEnabled value as the privacy-preserving default", async () => {
    // In-process (#8587): the malformed config was written into the in-process config dir BEFORE the bin
    // module was imported (see beforeAll) — the same order a spawned CLI sees the file at startup, so this
    // still exercises the load-time normalizeConfig dropping the non-boolean value.
    const status = JSON.parse(
      await captureStdout(() => mod.runCli(["telemetry", "status", "--json"])),
    ) as { telemetry: { enabled: boolean } };
    expect(status.telemetry.enabled).toBe(false);
  });

  it("rejects an unknown telemetry subcommand in both plain and --json modes", () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const env = {
      LOOPOVER_CONFIG_DIR: tempDir,
      LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
    };

    expect(() => run(["telemetry", "bogus"], env)).toThrow(
      /Unknown telemetry command: bogus\. Use enable \| disable \| status\./,
    );

    const failure = runExpectingFailure(["telemetry", "bogus", "--json"], env);
    expect(failure.status).not.toBe(0);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Unknown telemetry command: bogus/),
    });
  });
});
