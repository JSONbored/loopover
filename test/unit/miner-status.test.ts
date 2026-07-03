import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectStatus,
  resolveMinerStateDir,
  runDoctor,
  runDoctorChecks,
  runStatus,
} from "../../packages/gittensory-miner/lib/status.js";

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

  it("runStatus prints human-readable text (0) and machine JSON with --json", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus([], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("@jsonbored/gittensory-miner");
    log.mockClear();
    expect(runStatus(["--json"], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).stateDir).toBe("/s");
  });

  it("doctor passes on a healthy setup (writable state dir under this Node)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const checks = runDoctorChecks({ GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.map((check) => check.name)).toEqual(["node-version", "engine-resolves", "state-dir-writable"]);
    expect(runDoctor([], { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") })).toBe(0);
    expect(log).toHaveBeenCalled();
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
    runStatus(["--json"], { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") }, tempRoot());
    runDoctor([], { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
