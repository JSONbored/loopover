import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatLaptopDoctor,
  initLaptopMode,
  inspectLaptopMode,
  resolveLaptopModeConfigDir,
  resolveLaptopModeStateDbPath,
} from "../../packages/gittensory-miner/lib/laptop-mode.js";

const roots: string[] = [];

function tempRoot(prefix = "gittensory-miner-laptop-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gittensory-miner laptop mode bootstrap (#2329)", () => {
  it("resolves the config dir and state DB path from miner config env, then XDG, then the home default", () => {
    expect(resolveLaptopModeConfigDir({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe("/custom/config");
    expect(resolveLaptopModeStateDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/run-state.sqlite3",
    );
    expect(resolveLaptopModeConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gittensory-miner");
    expect(resolveLaptopModeStateDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gittensory-miner/run-state.sqlite3");
    expect(resolveLaptopModeConfigDir({})).toMatch(/\/\.config\/gittensory-miner$/);
    expect(resolveLaptopModeStateDbPath({})).toMatch(/\/\.config\/gittensory-miner\/run-state\.sqlite3$/);
  });

  it("keeps the laptop-mode config dir on the config chain even when the run-state DB path is overridden", () => {
    const env = {
      GITTENSORY_MINER_RUN_STATE_DB: "/custom/state.sqlite3",
      GITTENSORY_MINER_CONFIG_DIR: "/custom/config",
      XDG_CONFIG_HOME: "/xdg",
    };

    expect(resolveLaptopModeConfigDir(env)).toBe("/custom/config");
    expect(resolveLaptopModeStateDbPath(env)).toBe("/custom/state.sqlite3");
    expect(resolveLaptopModeConfigDir({
      GITTENSORY_MINER_RUN_STATE_DB: "/custom/state.sqlite3",
      XDG_CONFIG_HOME: "/xdg",
    })).toBe("/xdg/gittensory-miner");
  });

  it("initializes the config dir and SQLite run-state store on a fresh laptop-mode boot", () => {
    const configDir = join(tempRoot(), "config");
    const result = initLaptopMode({ env: { GITTENSORY_MINER_CONFIG_DIR: configDir } });

    expect(result).toMatchObject({
      configDir,
      configDirExisted: false,
      stateDbPath: join(configDir, "run-state.sqlite3"),
      stateDbExisted: false,
    });

    const db = new DatabaseSync(result.stateDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'miner_run_state'")
        .get();
      expect(row).toEqual({ name: "miner_run_state" });
    } finally {
      db.close();
    }
  });

  it("re-runs idempotently and repairs an existing empty file by creating the real schema", () => {
    const configDir = join(tempRoot(), "config");
    mkdirSync(configDir, { recursive: true });
    const stateDbPath = join(configDir, "run-state.sqlite3");
    writeFileSync(stateDbPath, "");

    const result = initLaptopMode({ env: { GITTENSORY_MINER_CONFIG_DIR: configDir } });

    expect(result).toMatchObject({
      configDir,
      configDirExisted: true,
      stateDbPath,
      stateDbExisted: true,
    });

    const header = readFileSync(stateDbPath).subarray(0, 16).toString("utf8");
    expect(header).toBe("SQLite format 3\u0000");

    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'miner_run_state'")
        .get();
      expect(row).toEqual({ name: "miner_run_state" });
    } finally {
      db.close();
    }
  });

  it("doctor reports a ready local state store and formats a human-readable summary", () => {
    const configDir = join(tempRoot(), "config");
    initLaptopMode({ env: { GITTENSORY_MINER_CONFIG_DIR: configDir } });

    const report = inspectLaptopMode({
      env: { GITTENSORY_MINER_CONFIG_DIR: configDir },
      spawnSyncFn: vi.fn(() => ({ status: 0, stdout: "Docker version 27.0.0", stderr: "" })) as never,
    });

    expect(report.configDir).toMatchObject({ path: configDir, exists: true, writable: true, error: null });
    expect(report.stateDb).toMatchObject({
      path: join(configDir, "run-state.sqlite3"),
      exists: true,
      writable: true,
      sqliteReady: true,
      schemaReady: true,
      schemaError: null,
    });
    expect(report.docker).toEqual({ available: true, detail: "Docker version 27.0.0" });
    expect(formatLaptopDoctor(report)).toContain("miner_run_state ready");
  });

  it("doctor treats a fresh, creatable config dir as writable and handles missing Docker gracefully", () => {
    const configDir = join(tempRoot(), "config");

    const report = inspectLaptopMode({
      env: { GITTENSORY_MINER_CONFIG_DIR: configDir },
      spawnSyncFn: vi.fn(() => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
      })) as never,
    });

    expect(report.configDir).toMatchObject({
      path: configDir,
      exists: false,
      writable: true,
      error: null,
    });
    expect(report.stateDb).toMatchObject({
      path: join(configDir, "run-state.sqlite3"),
      exists: false,
      writable: true,
      sqliteReady: false,
      schemaReady: false,
      schemaError: null,
    });
    expect(report.docker).toEqual({ available: false, detail: "docker not found on PATH" });
    expect(formatLaptopDoctor(report)).toContain("Docker: unavailable (docker not found on PATH; informational only)");
  });

  it("doctor treats a timed-out Docker probe as informational only", () => {
    const configDir = join(tempRoot(), "config");
    initLaptopMode({ env: { GITTENSORY_MINER_CONFIG_DIR: configDir } });

    const report = inspectLaptopMode({
      env: { GITTENSORY_MINER_CONFIG_DIR: configDir },
      spawnSyncFn: vi.fn(() => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
      })) as never,
    });

    expect(report.docker.available).toBe(false);
    expect(report.docker.detail).toContain("timed out");
    expect(formatLaptopDoctor(report)).toContain("informational only");
  });

  it("doctor surfaces an invalid existing SQLite file with the schema error detail in the human output", () => {
    const configDir = join(tempRoot(), "config");
    mkdirSync(configDir, { recursive: true });
    const stateDbPath = join(configDir, "run-state.sqlite3");
    writeFileSync(stateDbPath, "not a sqlite database");

    const report = inspectLaptopMode({
      env: { GITTENSORY_MINER_CONFIG_DIR: configDir },
      spawnSyncFn: vi.fn(() => ({ status: 0, stdout: "Docker version 27.0.0", stderr: "" })) as never,
    });

    expect(report.stateDb).toMatchObject({
      path: stateDbPath,
      exists: true,
      writable: true,
      sqliteReady: false,
      schemaReady: false,
    });
    expect(report.stateDb.schemaError).toBeTruthy();
    expect(formatLaptopDoctor(report)).toContain(report.stateDb.schemaError!);
  });

  it("documents the laptop-mode quickstart in the package README", () => {
    const readme = readFileSync("packages/gittensory-miner/README.md", "utf8");

    expect(readme).toMatch(/npm install -g @jsonbored\/gittensory-miner/);
    expect(readme).toContain("gittensory-miner init");
    expect(readme).toContain("gittensory-miner doctor");
    expect(readme).toContain("run-state.sqlite3");
    expect(readme).toMatch(/Laptop mode never requires Docker, Redis, or\s+Postgres/i);
  });
});
