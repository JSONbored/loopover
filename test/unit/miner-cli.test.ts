import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeFixtureServer,
  runCapture,
  startRegistryFixture,
} from "./support/miner-cli-harness";

type MinerCli = typeof import("../../packages/gittensory-miner/lib/cli.js");
type MinerUpdateCheck =
  typeof import("../../packages/gittensory-miner/lib/update-check.js");

let printHelp: MinerCli["printHelp"];
let printVersion: MinerCli["printVersion"];
let runCli: MinerCli["runCli"];
let compareSemver: MinerUpdateCheck["compareSemver"];
let fetchLatestPackageVersion: MinerUpdateCheck["fetchLatestPackageVersion"];
let maybePrintUpdateNudge: MinerUpdateCheck["maybePrintUpdateNudge"];
let resolveNpmRegistryUrl: MinerUpdateCheck["resolveNpmRegistryUrl"];
let resolveUpgradeCommand: MinerUpdateCheck["resolveUpgradeCommand"];
let shouldSkipUpdateCheck: MinerUpdateCheck["shouldSkipUpdateCheck"];
let startUpdateCheck: MinerUpdateCheck["startUpdateCheck"];

beforeAll(async () => {
  const cli = await import("../../packages/gittensory-miner/lib/cli.js");
  const updateCheck =
    await import("../../packages/gittensory-miner/lib/update-check.js");
  ({ printHelp, printVersion, runCli } = cli);
  ({
    compareSemver,
    fetchLatestPackageVersion,
    maybePrintUpdateNudge,
    resolveNpmRegistryUrl,
    resolveUpgradeCommand,
    shouldSkipUpdateCheck,
    startUpdateCheck,
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
});
