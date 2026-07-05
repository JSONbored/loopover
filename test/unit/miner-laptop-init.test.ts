import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDockerPresent,
  checkLaptopStateSqlite,
  initLaptopState,
  resolveLaptopStateDbPath,
  runInit,
} from "../../packages/gittensory-miner/lib/laptop-init.js";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-init-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner laptop init (#2329)", () => {
  it("resolves the laptop SQLite path from the state-dir override and XDG fallback", () => {
    expect(resolveLaptopStateDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/state" }))
      .toBe("/custom/state/laptop-state.sqlite3");
    expect(resolveLaptopStateDbPath({ XDG_CONFIG_HOME: "/xdg" }))
      .toBe("/xdg/gittensory-miner/laptop-state.sqlite3");
  });

  it("fresh init creates the state dir and SQLite file", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    expect(first.created).toBe(true);
    expect(existsSync(first.dbPath)).toBe(true);
    expect(existsSync(first.stateDir)).toBe(true);
    expect(checkLaptopStateSqlite(env).ok).toBe(true);
  });

  it("re-running init is idempotent and does not clobber existing metadata", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const first = initLaptopState(env);
    writeFileSync(join(first.stateDir, "marker.txt"), "keep-me");
    const second = initLaptopState(env);
    expect(second.created).toBe(false);
    expect(readFileSync(join(first.stateDir, "marker.txt"), "utf8")).toBe("keep-me");
  });

  it("runInit prints human text (0) and machine JSON with --json", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInit([], env)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("initialized");
    log.mockClear();
    expect(runInit(["--json"], env)).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.created).toBe(false);
    expect(payload.dbPath).toBe(resolveLaptopStateDbPath(env));
  });

  it("doctor sqlite check reports a missing file with guidance", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const check = checkLaptopStateSqlite(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("gittensory-miner init");
  });

  it("doctor sqlite check reports unreadable files", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const dbPath = resolveLaptopStateDbPath(env);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(dbPath, "not-a-sqlite-db");
    chmodSync(dbPath, 0o600);
    const check = checkLaptopStateSqlite(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(dbPath);
  });

  it("doctor reports absent Docker gracefully (informational, always ok)", () => {
    const check = checkDockerPresent({ resolveDockerPath: () => null });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("optional");
  });

  it("doctor reports Docker when which finds it", () => {
    const check = checkDockerPresent({ resolveDockerPath: () => "/usr/bin/docker" });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/usr/bin/docker");
  });

  it("runInit notes when sqlite already existed", () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    initLaptopState(env);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInit([], env)).toBe(0);
    expect(String(log.mock.calls[1]?.[0])).toContain("already existed");
  });

  it("makes no network calls", () => {
    const fetchStub = vi.fn(() => {
      throw new Error("network calls are forbidden");
    });
    vi.stubGlobal("fetch", fetchStub);
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    vi.spyOn(console, "log").mockImplementation(() => {});
    runInit([], env);
    checkDockerPresent();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
