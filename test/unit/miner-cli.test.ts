import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bin,
  closeFixtureServer,
  runCapture,
  startRegistryFixture,
} from "./support/miner-cli-harness";

type MinerCli = typeof import("../../packages/loopover-miner/lib/cli.js");
type MinerUpdateCheck =
  typeof import("../../packages/loopover-miner/lib/update-check.js");

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
let awaitOpportunisticUpdateCheck: MinerUpdateCheck["awaitOpportunisticUpdateCheck"];

beforeAll(async () => {
  const cli = await import("../../packages/loopover-miner/lib/cli.js");
  const updateCheck =
    await import("../../packages/loopover-miner/lib/update-check.js");
  ({ printHelp, printVersion, runCli } = cli);
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

describe("loopover-miner CLI helpers", () => {
  it("prints the package version with the node runtime", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printVersion({
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("@loopover/miner/0.1.0"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining(process.version));
  });

  it("prints help text with the supported commands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printHelp({ packageName: "@loopover/miner" });
    const text = log.mock.calls[0]?.[0];
    expect(text).toContain("loopover-miner --help");
    expect(text).toContain("loopover-miner version");
    expect(text).toContain("loopover-miner metrics");
    expect(text).toContain("loopover-miner migrate [--json]");
    expect(text).toContain("loopover-miner ledger metrics");
    expect(text).toContain("loopover-miner queue dashboard [--json]");
    expect(text).toContain("loopover-miner pr-outcomes --login <github-login>");
    expect(text).toContain("--no-update-check");
  });

  it("returns exit code 1 for unknown commands", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      runCli(["mystery"], { packageName: "@loopover/miner" }),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Unknown command: mystery. Run @loopover/miner --help.",
    );
  });

  it("emits JSON for unknown commands when --json is set (#4836)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runCli(["mystery", "--json"], { packageName: "@loopover/miner" }),
    ).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Unknown command: mystery. Run @loopover/miner --help.",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the CLI version source aligned with package metadata", async () => {
    const packageJson = await import(
      "../../packages/loopover-miner/package.json",
      { with: { type: "json" } }
    );
    const { resolveMinerVersion } = await import(
      "../../packages/loopover-miner/lib/version.js"
    );
    expect(resolveMinerVersion({})).toBe(packageJson.default.version);
  });
});

describe("loopover-miner startup update check (#2331)", () => {
  it("mirrors the mcp npm registry and upgrade command conventions", () => {
    expect(resolveNpmRegistryUrl({})).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "https://registry.example.com/",
      }),
    ).toBe("https://registry.example.com");
    expect(resolveUpgradeCommand("@loopover/miner")).toBe(
      "npm install -g @loopover/miner@latest",
    );
  });

  it("falls back to the default npm registry for unsafe or invalid registry URLs", () => {
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "file:///etc/passwd",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "http://169.254.169.254/",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "https://user:pass@registry.example.com/",
      }),
    ).toBe("https://registry.npmjs.org");
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "not-a-url",
      }),
    ).toBe("https://registry.npmjs.org");
  });

  it("allows http registry URLs only on local loopback hosts", () => {
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "http://127.0.0.1:4873/",
      }),
    ).toBe("http://127.0.0.1:4873");
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "http://localhost:4873/",
      }),
    ).toBe("http://localhost:4873");
  });

  it("skips the check when --no-update-check or LOOPOVER_MINER_NO_UPDATE_CHECK=1 is set", () => {
    expect(shouldSkipUpdateCheck(["--version", "--no-update-check"])).toBe(
      true,
    );
    expect(
      shouldSkipUpdateCheck(["version"], {
        LOOPOVER_MINER_NO_UPDATE_CHECK: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipUpdateCheck(["version"], {
        LOOPOVER_MINER_NO_UPDATE_CHECK: "true",
      }),
    ).toBe(true);
    expect(shouldSkipUpdateCheck(["version"], {})).toBe(false);
  });

  it("orders semver values the same way as loopover-mcp", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.5.0", "0.5.0-rc.1")).toBe(1);
    expect(compareSemver("0.6.0", "0.7.0-rc.1")).toBe(-1);
  });

  it("REGRESSION: compares numeric prerelease identifiers as decimal strings, not via Number() (precision loss past 2^53-1)", () => {
    // 9007199254740992 is 2^53 (Number.MAX_SAFE_INTEGER + 1); 9007199254740993 (2^53+1) cannot be represented
    // exactly as a float64 and rounds DOWN to the same value, so Number(leftId) !== Number(rightId) would
    // wrongly report these two distinct numeric identifiers as equal. Comparing as strings (length, then
    // lexicographic) gets it right: the second is genuinely one greater than the first.
    expect(compareSemver("0.1.0-9007199254740993", "0.1.0-9007199254740992")).toBe(1);
    expect(compareSemver("0.1.0-9007199254740992", "0.1.0-9007199254740993")).toBe(-1);
    expect(compareSemver("0.1.0-9007199254740992", "0.1.0-9007199254740992")).toBe(0);
  });

  it("returns null for an unparseable version string on either side", () => {
    expect(compareSemver("not-a-version", "0.1.0")).toBeNull();
    expect(compareSemver("0.1.0", "not-a-version")).toBeNull();
    expect(compareSemver("also-not-a-version", "not-a-version")).toBeNull();
  });

  it("compares prerelease identifier lists of different lengths (the shorter list sorts lower)", () => {
    expect(compareSemver("0.1.0-alpha", "0.1.0-alpha.1")).toBe(-1);
    expect(compareSemver("0.1.0-alpha.1", "0.1.0-alpha")).toBe(1);
  });

  it("ranks a numeric prerelease identifier below a non-numeric one at the same position", () => {
    expect(compareSemver("0.1.0-1", "0.1.0-alpha")).toBe(-1);
    expect(compareSemver("0.1.0-alpha", "0.1.0-1")).toBe(1);
  });

  it("compares two differing non-numeric prerelease identifiers lexicographically", () => {
    expect(compareSemver("0.1.0-alpha", "0.1.0-beta")).toBe(-1);
    expect(compareSemver("0.1.0-beta", "0.1.0-alpha")).toBe(1);
  });

  it("compares differing-length numeric prerelease identifiers by length, not value", () => {
    expect(compareSemver("0.1.0-2", "0.1.0-10")).toBe(-1);
    expect(compareSemver("0.1.0-10", "0.1.0-2")).toBe(1);
  });

  it("compares same-length numeric prerelease identifiers lexicographically in both directions", () => {
    expect(compareSemver("0.1.0-2", "0.1.0-3")).toBe(-1);
    expect(compareSemver("0.1.0-3", "0.1.0-2")).toBe(1);
  });

  it("continues past an equal leading numeric identifier to decide on a later one", () => {
    expect(compareSemver("0.1.0-5.2", "0.1.0-5.3")).toBe(-1);
    expect(compareSemver("0.1.0-5.3", "0.1.0-5.2")).toBe(1);
  });

  it("ranks a version with a prerelease below the same version with none, on either side", () => {
    expect(compareSemver("0.5.0-rc.1", "0.5.0")).toBe(-1);
    expect(compareSemver("0.5.0", "0.5.0-rc.1")).toBe(1);
  });

  it("resolveNpmRegistryUrl trims a non-root pathname's trailing slashes", () => {
    expect(
      resolveNpmRegistryUrl({
        LOOPOVER_NPM_REGISTRY_URL: "https://registry.example.com/npm-proxy/",
      }),
    ).toBe("https://registry.example.com/npm-proxy");
  });

  it("fetchLatestPackageVersion builds an unscoped registry path (no %2F encoding)", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "9.9.9" });
    await expect(
      fetchLatestPackageVersion({ packageName: "some-unscoped-package", npmRegistryUrl: registryUrl }),
    ).rejects.toThrow("npm_latest_version_unavailable");
  });

  it("awaitOpportunisticUpdateCheck swallows a rejecting update check instead of throwing", async () => {
    const rejecting = Promise.reject(new Error("registry blew up"));
    await expect(awaitOpportunisticUpdateCheck(rejecting, 50)).resolves.toBeUndefined();
  });

  it("prints a one-line upgrade nudge when npm latest is newer", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "9.9.9" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await maybePrintUpdateNudge({
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
      npmRegistryUrl: registryUrl,
      upgradeCommand: "npm install -g @loopover/miner@latest",
    });
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @loopover/miner@latest\n",
    );
  });

  it("prints nothing when the installed version matches npm latest", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "0.1.0" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await maybePrintUpdateNudge({
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
      npmRegistryUrl: registryUrl,
      upgradeCommand: "npm install -g @loopover/miner@latest",
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("swallows registry failures without throwing", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 500 });
    await expect(
      maybePrintUpdateNudge({
        packageName: "@loopover/miner",
        packageVersion: "0.1.0",
        npmRegistryUrl: registryUrl,
        upgradeCommand: "npm install -g @loopover/miner@latest",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when fetchLatestPackageVersion cannot reach the registry", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 503 });
    await expect(
      fetchLatestPackageVersion({
        packageName: "@loopover/miner",
        npmRegistryUrl: registryUrl,
      }),
    ).rejects.toThrow("npm_latest_version_unavailable");
  });

  it("startUpdateCheck resolves immediately when opted out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await startUpdateCheck(["--no-update-check"], {
      packageName: "@loopover/miner",
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
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
      env: { LOOPOVER_NPM_REGISTRY_URL: registryUrl },
    });
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @loopover/miner@latest\n",
    );
  });

  it("startUpdateCheck stays silent when npm latest matches the installed version", async () => {
    const registryUrl = await startRegistryFixture({ latestVersion: "0.1.0" });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await startUpdateCheck(["--version"], {
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
      env: { LOOPOVER_NPM_REGISTRY_URL: registryUrl },
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("startUpdateCheck swallows registry failures without throwing", async () => {
    const registryUrl = await startRegistryFixture({ npmStatus: 500 });
    await expect(
      startUpdateCheck(["--version"], {
        packageName: "@loopover/miner",
        packageVersion: "0.1.0",
        env: { LOOPOVER_NPM_REGISTRY_URL: registryUrl },
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
      packageName: "@loopover/miner",
      packageVersion: "0.1.0",
      env: { LOOPOVER_NPM_REGISTRY_URL: registryUrl },
    });
    await awaitOpportunisticUpdateCheck(updateCheck);
    expect(stderr).toHaveBeenCalledWith(
      "npm install -g @loopover/miner@latest\n",
    );
  });

  it("serves --version without blocking when update checks are disabled", async () => {
    const packageJson = await import(
      "../../packages/loopover-miner/package.json",
      { with: { type: "json" } }
    );
    const output = runCapture(["--version", "--no-update-check"]);
    expect(output).toContain(`@loopover/miner/${packageJson.default.version}`);
  });

  it("serves --help immediately without waiting for a slow registry check", async () => {
    const registryUrl = await startRegistryFixture({
      latestVersion: "9.9.9",
      delayMs: 10_000,
    });
    const startedAt = Date.now();
    const output = runCapture(["--help"], {
      LOOPOVER_NPM_REGISTRY_URL: registryUrl,
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(output).toContain("loopover-miner --help");
    expect(output).not.toContain(
      "npm install -g @loopover/miner@latest",
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
        LOOPOVER_NPM_REGISTRY_URL: registryUrl,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: mystery");
  });
});
