import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEngineVersionSkewCheck,
  collectStatus,
  compareInstalledEngineVersion,
  readExpectedEnginePackageVersion,
  readExpectedEnginePackageVersionFromPaths,
  readInstalledEnginePackageVersion,
  readInstalledEnginePackageVersionFromPaths,
  resolveMinerStateDir,
  runDoctor,
  runDoctorChecks,
  runStatus,
} from "../../packages/gittensory-miner/lib/status.js";
import { initLaptopState } from "../../packages/gittensory-miner/lib/laptop-init.js";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-status-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner status/doctor (#2288)", () => {
  it("resolves the state dir from the config-dir override, XDG, then the home default", () => {
    expect(resolveMinerStateDir({ GITTENSORY_MINER_CONFIG_DIR: "/custom/state" })).toBe("/custom/state");
    expect(resolveMinerStateDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gittensory-miner");
    expect(resolveMinerStateDir({})).toMatch(/\/\.config\/gittensory-miner$/);
  });

  it("collectStatus reports the installed versions, state dir, and config-file discovery", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-miner.yml"), "minerEnabled: true\n");
    const status = collectStatus({ GITTENSORY_MINER_CONFIG_DIR: join(root, "state") }, root);
    expect(status.package.name).toBe("@jsonbored/gittensory-miner");
    expect(typeof status.package.version).toBe("string");
    expect(status.engine.name).toBe("@jsonbored/gittensory-engine");
    expect(status.stateDir).toBe(join(root, "state"));
    expect(status.configFile).toBe(join(root, ".gittensory-miner.yml")); // discovered
  });

  it("collectStatus prefers GITTENSORY_MINER_VERSION over package.json (#4310)", () => {
    const status = collectStatus(
      {
        GITTENSORY_MINER_CONFIG_DIR: "/s",
        GITTENSORY_MINER_VERSION: "gittensory-miner-fleet@deadbeef",
      },
      tempRoot(),
    );
    expect(status.package.version).toBe("gittensory-miner-fleet@deadbeef");
  });

  it("runStatus prints human-readable text (0) and machine JSON with --json", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus([], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("@jsonbored/gittensory-miner");
    log.mockClear();
    expect(runStatus(["--json"], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).stateDir).toBe("/s");
  });

  it("doctor passes on a healthy setup (writable state dir, initialized sqlite, optional Docker)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") };
    initLaptopState(env);
    const checks = runDoctorChecks(env);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.map((check) => check.name)).toEqual([
      "node-version",
      "engine-resolves",
      "engine-version-skew",
      "state-dir-writable",
      "laptop-state-sqlite",
      "docker-present",
      "claude-cli-present",
      "codex-cli-present",
    ]);
    expect(runDoctor([], env)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("engine version skew helpers compare installed vs expected semver", () => {
    expect(compareInstalledEngineVersion("0.2.0", "0.2.0")).toBe(0);
    expect(compareInstalledEngineVersion("0.1.0", "0.2.0")).toBe(-1);
    expect(compareInstalledEngineVersion("0.3.0", "0.2.0")).toBe(1);
    expect(typeof readInstalledEnginePackageVersion()).toBe("string");
    expect(readExpectedEnginePackageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("buildEngineVersionSkewCheck skips when expected version is unavailable", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.2.0",
      () => null,
    );
    expect(skewCheck.ok).toBe(true);
    expect(skewCheck.detail).toContain("skipped");
  });

  it("buildEngineVersionSkewCheck fails when installed engine is missing", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => null,
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(false);
    expect(skewCheck.detail).toContain("not installed");
  });

  it("readExpectedEnginePackageVersionFromPaths prefers monorepo package.json then the pin file", () => {
    const root = tempRoot();
    const monorepoPkg = join(root, "engine-package.json");
    const pinFile = join(root, "expected-engine.version");
    writeFileSync(monorepoPkg, JSON.stringify({ version: "0.2.0" }));
    writeFileSync(pinFile, "0.1.0\n");
    expect(readExpectedEnginePackageVersionFromPaths(monorepoPkg, pinFile)).toBe("0.2.0");

    expect(readExpectedEnginePackageVersionFromPaths(join(root, "missing.json"), pinFile)).toBe("0.1.0");
    expect(readExpectedEnginePackageVersionFromPaths(join(root, "missing.json"), join(root, "missing-pin"))).toBeNull();
    writeFileSync(join(root, "broken.json"), "not-json");
    expect(readExpectedEnginePackageVersionFromPaths(join(root, "broken.json"), pinFile)).toBeNull();
  });

  it("readInstalledEnginePackageVersionFromPaths falls back to the workspace engine package", () => {
    const root = tempRoot();
    const workspacePkg = join(root, "gittensory-engine-package.json");
    writeFileSync(workspacePkg, JSON.stringify({ version: "0.2.0" }));
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", workspacePkg)).toBe("0.2.0");
    writeFileSync(workspacePkg, "not-json");
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", workspacePkg)).toBeNull();
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", join(root, "missing.json"))).toBeNull();

    const installedPkg = join(root, "installed", "package.json");
    mkdirSync(join(root, "installed"), { recursive: true });
    writeFileSync(installedPkg, JSON.stringify({ version: "0.2.1" }));
    expect(readInstalledEnginePackageVersionFromPaths(join(root, "installed", "index.js"), workspacePkg)).toBe("0.2.1");
  });

  it("runDoctor supports --json output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") };
    initLaptopState(env);
    expect(runDoctor(["--json"], env)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).checks).toBeDefined();
  });

  it("buildEngineVersionSkewCheck reports behind when installed engine lags expected", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.1.0",
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(false);
    expect(skewCheck.detail).toContain("behind");
  });

  it("buildEngineVersionSkewCheck reports ahead when installed engine exceeds expected", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.3.0",
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(true);
    expect(skewCheck.detail).toContain("ahead");
  });

  it("doctor fails (exit 1) when the state directory cannot be created", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    // Point the state dir UNDER a regular file → mkdir throws ENOTDIR.
    const root = tempRoot();
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "");
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(filePath, "state") };
    expect(runDoctorChecks(env).find((check) => check.name === "state-dir-writable")?.ok).toBe(false);
    expect(runDoctor([], env)).toBe(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it("makes no network calls", () => {
    const fetchStub = vi.fn(() => {
      throw new Error("network calls are forbidden");
    });
    vi.stubGlobal("fetch", fetchStub);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") };
    initLaptopState(env);
    runStatus(["--json"], env, tempRoot());
    runDoctor([], env);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
