import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bin,
  closeFixtureServer,
  runCapture,
  startRegistryFixture,
} from "./support/miner-cli-harness";

type MinerCli = typeof import("../../packages/gittensory-miner/lib/cli.js");
type MinerUpdateCheck =
  typeof import("../../packages/gittensory-miner/lib/update-check.js");

let printHelp: MinerCli["printHelp"];
let printVersion: MinerCli["printVersion"];
let resolveMinerConfigDir: MinerCli["resolveMinerConfigDir"];
let resolveMinerStatePath: MinerCli["resolveMinerStatePath"];
let initMinerState: MinerCli["initMinerState"];
let inspectDoctor: MinerCli["inspectDoctor"];
let runCli: MinerCli["runCli"];
let compareSemver: MinerUpdateCheck["compareSemver"];
let fetchLatestPackageVersion: MinerUpdateCheck["fetchLatestPackageVersion"];
let maybePrintUpdateNudge: MinerUpdateCheck["maybePrintUpdateNudge"];
let resolveNpmRegistryUrl: MinerUpdateCheck["resolveNpmRegistryUrl"];
let resolveUpgradeCommand: MinerUpdateCheck["resolveUpgradeCommand"];
let shouldSkipUpdateCheck: MinerUpdateCheck["shouldSkipUpdateCheck"];
let startUpdateCheck: MinerUpdateCheck["startUpdateCheck"];
let awaitOpportunisticUpdateCheck: MinerUpdateCheck["awaitOpportunisticUpdateCheck"];

beforeAll(async () => {
  const cli = await import("../../packages/gittensory-miner/lib/cli.js");
  const updateCheck =
    await import("../../packages/gittensory-miner/lib/update-check.js");
  ({
    printHelp,
    printVersion,
    resolveMinerConfigDir,
    resolveMinerStatePath,
    initMinerState,
    inspectDoctor,
    runCli,
  } = cli);
  ({
    compareSemver,
    fetchLatestPackageVersion,
    maybePrintUpdateNudge,
    resolveNpmRegistryUrl,
    resolveUpgradeCommand,
    shouldSkipUpdateCheck,
    startUpdateCheck,
    awaitOpportunisticUpdateCheck,
  } = updateCheck);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeFixtureServer();
});

describe("gittensory-miner CLI helpers", () => {
  it("prints the package version with the node runtime", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printVersion({
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("@jsonbored/gittensory-miner/0.1.0"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining(process.version));
  });

  it("prints help text with the supported commands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printHelp({ packageName: "@jsonbored/gittensory-miner" });
    const text = log.mock.calls[0]?.[0];
    expect(text).toContain("gittensory-miner --help");
    expect(text).toContain("gittensory-miner version");
    expect(text).toContain("--no-update-check");
  });

  it("returns exit code 1 for unknown commands", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      runCli(["mystery"], { packageName: "@jsonbored/gittensory-miner" }),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Unknown command: mystery. Run @jsonbored/gittensory-miner --help.",
    );
  });

  it("resolves laptop-mode config/state paths with the mcp-style fallback chain (#2329)", () => {
    const home = mkdtempSync(join(tmpdir(), "miner-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "miner-xdg-"));
    expect(resolveMinerConfigDir({ GITTENSORY_MINER_CONFIG_DIR: "C:/custom/miner" })).toBe(
      "C:/custom/miner",
    );
    expect(resolveMinerConfigDir({ XDG_CONFIG_HOME: xdg, HOME: home })).toBe(
      join(xdg, "gittensory-miner"),
    );
    expect(resolveMinerStatePath({ XDG_CONFIG_HOME: xdg })).toBe(
      join(xdg, "gittensory-miner", "state.sqlite3"),
    );
  });

  it("init creates a local state file and stays idempotent (#2329)", () => {
    const root = mkdtempSync(join(tmpdir(), "miner-init-"));
    const configDir = join(root, "cfg");
    const env = { GITTENSORY_MINER_CONFIG_DIR: configDir };
    const first = initMinerState(env);
    expect(first.createdConfigDir).toBe(true);
    expect(first.createdStateFile).toBe(true);
    expect(existsSync(first.statePath)).toBe(true);

    writeFileSync(first.statePath, "sentinel");
    const second = initMinerState(env);
    expect(second.createdConfigDir).toBe(false);
    expect(second.createdStateFile).toBe(false);
    expect(readFileSync(second.statePath, "utf8")).toBe("sentinel");
    rmSync(root, { recursive: true, force: true });
  });

  it("doctor reports local state and absent Docker gracefully (#2329)", () => {
    const root = mkdtempSync(join(tmpdir(), "miner-doctor-"));
    const configDir = join(root, "cfg");
    mkdirSync(configDir, { recursive: true });
    const statePath = join(configDir, "state.sqlite3");
    writeFileSync(statePath, "");
    const doctor = inspectDoctor({ GITTENSORY_MINER_CONFIG_DIR: configDir });
    expect(doctor.stateExists).toBe(true);
    expect(doctor.stateWritable).toBe(true);
    expect(typeof doctor.dockerPresent).toBe("boolean");
    rmSync(root, { recursive: true, force: true });
  });

  it("bin init + doctor --json work end-to-end (#2329)", () => {
    const root = mkdtempSync(join(tmpdir(), "miner-bin-"));
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "cfg") };
    const initOutput = runCapture(["init", "--no-update-check"], env);
    expect(initOutput).toContain("state initialized");
    const doctorOutput = runCapture(["doctor", "--json", "--no-update-check"], env);
    const parsed = JSON.parse(doctorOutput);
    expect(parsed.stateExists).toBe(true);
    expect(parsed.stateWritable).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the CLI version source aligned with package metadata", async () => {
    const packageJson = await import(
      "../../packages/gittensory-miner/package.json",
      { with: { type: "json" } }
    );
    expect(packageJson.default.version).toBe("0.1.0");
  });
});

describe("gittensory-miner startup update check (#2331)", () => {
  it("mirrors the mcp npm registry and upgrade command conventions", () => {
    expect(resolveNpmRegistryUrl({})).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "https://registry.example.com/",
      }),
    ).toBe("https://registry.example.com");
    expect(resolveUpgradeCommand("@jsonbored/gittensory-miner")).toBe(
      "npm install -g @jsonbored/gittensory-miner@latest",
    );
  });

  it("falls back to the default npm registry for unsafe or invalid registry URLs", () => {
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "file:///etc/passwd",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "http://169.254.169.254/",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "https://user:pass@registry.example.com/",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "not-a-url",
      }),
    ).toBe("https://registry.npmjs.org");
  });

  it("allows http registry URLs only on local loopback hosts", () => {
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "http://127.0.0.1:4873/",
      }),
    ).toBe("http://127.0.0.1:4873");
    expect(
      resolveNpmRegistryUrl({
        GITTENSORY_NPM_REGISTRY_URL: "http://localhost:4873/",
      }),
    ).toBe("http://localhost:4873");
  });

  it("skips the check when --no-update-check or GITTENSORY_MINER_NO_UPDATE_CHECK=1 is set", () => {
    expect(shouldSkipUpdateCheck(["--version", "--no-update-check"])).toBe(
      true,
    );
    expect(
      shouldSkipUpdateCheck(["version"], {
        GITTENSORY_MINER_NO_UPDATE_CHECK: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipUpdateCheck(["version"], {
        GITTENSORY_MINER_NO_UPDATE_CHECK: "true",
      }),
    ).toBe(true);
    expect(shouldSkipUpdateCheck(["version"], {})).toBe(false);
  });

  it("orders semver values the same way as gittensory-mcp", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.5.0", "0.5.0-rc.1")).toBe(1);
    expect(compareSemver("0.6.0", "0.7.0-rc.1")).toBe(-1);
  });

  it("prints a one-line upgrade nudge when npm latest is newer", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "9.9.9" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await maybePrintUpdateNudge({
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
      npmRegistryUrl: registryUrl,
      upgradeCommand: "npm install -g @jsonbored/gittensory-miner@latest",
    });
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @jsonbored/gittensory-miner@latest\n",
    );
  });

  it("prints nothing when the installed version matches npm latest", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "0.1.0" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await maybePrintUpdateNudge({
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
      npmRegistryUrl: registryUrl,
      upgradeCommand: "npm install -g @jsonbored/gittensory-miner@latest",
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("swallows registry failures without throwing", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 500 });
    await expect(
      maybePrintUpdateNudge({
        packageName: "@jsonbored/gittensory-miner",
        packageVersion: "0.1.0",
        npmRegistryUrl: registryUrl,
        upgradeCommand: "npm install -g @jsonbored/gittensory-miner@latest",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when fetchLatestPackageVersion cannot reach the registry", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 503 });
    await expect(
      fetchLatestPackageVersion({
        packageName: "@jsonbored/gittensory-miner",
        npmRegistryUrl: registryUrl,
      }),
    ).rejects.toThrow("npm_latest_version_unavailable");
  });

  it("startUpdateCheck resolves immediately when opted out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await startUpdateCheck(["--no-update-check"], {
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("startUpdateCheck prints the nudge when npm latest is newer", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "9.9.9" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await startUpdateCheck(["--version"], {
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
      env: { GITTENSORY_NPM_REGISTRY_URL: registryUrl },
    });
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @jsonbored/gittensory-miner@latest\n",
    );
  });

  it("startUpdateCheck stays silent when npm latest matches the installed version", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "0.1.0" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await startUpdateCheck(["--version"], {
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
      env: { GITTENSORY_NPM_REGISTRY_URL: registryUrl },
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("startUpdateCheck swallows registry failures without throwing", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 500 });
    await expect(
      startUpdateCheck(["--version"], {
        packageName: "@jsonbored/gittensory-miner",
        packageVersion: "0.1.0",
        env: { GITTENSORY_NPM_REGISTRY_URL: registryUrl },
      }),
    ).resolves.toBeUndefined();
  });

  it("awaitOpportunisticUpdateCheck waits for a fast update check but caps slow lookups", async () => {
    let resolved = false;
    const fastCheck = Promise.resolve().then(() => {
      resolved = true;
    });
    await awaitOpportunisticUpdateCheck(fastCheck, 250);
    expect(resolved).toBe(true);

    const startedAt = Date.now();
    await awaitOpportunisticUpdateCheck(new Promise(() => undefined), 50);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("awaitOpportunisticUpdateCheck lets a fast update check finish before exit", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "9.9.9" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const updateCheck = startUpdateCheck(["mystery"], {
      packageName: "@jsonbored/gittensory-miner",
      packageVersion: "0.1.0",
      env: { GITTENSORY_NPM_REGISTRY_URL: registryUrl },
    });
    await awaitOpportunisticUpdateCheck(updateCheck);
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @jsonbored/gittensory-miner@latest\n",
    );
  });

  it("serves --version without blocking when update checks are disabled", () => {
    const output = runCapture(["--version", "--no-update-check"]);
    expect(output).toContain("@jsonbored/gittensory-miner/0.1.0");
  });

  it("serves --help immediately without waiting for a slow registry check", async () => {
    const registryUrl = await startRegistryFixture({
      latestVersion: "9.9.9",
      delayMs: 10_000,
    });
    const startedAt = Date.now();
    const output = runCapture(["--help"], {
      GITTENSORY_NPM_REGISTRY_URL: registryUrl,
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(output).toContain("gittensory-miner --help");
    expect(output).not.toContain(
      "npm install -g @jsonbored/gittensory-miner@latest",
    );
  });

  it("returns unknown-command errors immediately without waiting for a slow registry check", async () => {
    const registryUrl = await startRegistryFixture({
      latestVersion: "9.9.9",
      delayMs: 10_000,
    });
    const startedAt = Date.now();
    const result = spawnSync("node", [bin, "mystery"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITTENSORY_NPM_REGISTRY_URL: registryUrl,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: mystery");
  });
});
