import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUN_STATES,
  closeDefaultRunStateStore,
  getRunState,
  initRunStateStore,
  listRunStates,
  resolveRunStateDbPath,
  setRunState,
} from "../../packages/gittensory-miner/lib/run-state.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-run-state-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  closeDefaultRunStateStore();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gittensory-miner run-state store (#2289)", () => {
  it("keeps the package engine floor aligned with unflagged node:sqlite support", () => {
    const packageJson = JSON.parse(
      readFileSync("packages/gittensory-miner/package.json", "utf8"),
    ) as { engines?: { node?: string } };

    expect(packageJson.engines?.node).toBe(">=22.13.0");
  });

  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveRunStateDbPath({ GITTENSORY_MINER_RUN_STATE_DB: "/custom/state.sqlite3" })).toBe(
      "/custom/state.sqlite3",
    );
    expect(resolveRunStateDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/run-state.sqlite3",
    );
    expect(resolveRunStateDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/gittensory-miner/run-state.sqlite3",
    );
    expect(resolveRunStateDbPath({})).toMatch(/\/\.config\/gittensory-miner\/run-state\.sqlite3$/);
  });

  it("creates the SQLite table on first use and reads null before any write", () => {
    const dbPath = join(tempRoot(), "nested", "run-state.sqlite3");
    const store = initRunStateStore(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).mode & 0o077).toBe(0);
      expect(store.getRunState("JSONbored/gittensory")).toBeNull();

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'miner_run_state'")
          .get();
        expect(row).toEqual({ name: "miner_run_state" });
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("round-trips every fixed run state and records updated_at timestamps", () => {
    const dbPath = join(tempRoot(), "run-state.sqlite3");
    const store = initRunStateStore(dbPath);
    try {
      for (const state of RUN_STATES) {
        const write = store.setRunState(" JSONbored/gittensory ", state);
        expect(write.repoFullName).toBe("JSONbored/gittensory");
        expect(write.state).toBe(state);
        expect(Date.parse(write.updatedAt)).not.toBeNaN();
        expect(store.getRunState("JSONbored/gittensory")).toBe(state);
      }
    } finally {
      store.close();
    }
  });

  it("reopens an existing DB file without truncating stored repo state", () => {
    const dbPath = join(tempRoot(), "run-state.sqlite3");
    const first = initRunStateStore(dbPath);
    first.setRunState("acme/widgets", "planning");
    first.close();

    const second = initRunStateStore(dbPath);
    try {
      expect(second.getRunState("acme/widgets")).toBe("planning");
      second.setRunState("acme/widgets", "preparing");
      expect(second.getRunState("acme/widgets")).toBe("preparing");
    } finally {
      second.close();
    }
  });

  it("exposes module-level get/set helpers backed by the default local DB path", () => {
    vi.stubEnv("GITTENSORY_MINER_RUN_STATE_DB", join(tempRoot(), "default.sqlite3"));

    expect(getRunState("acme/widgets")).toBeNull();
    expect(setRunState("acme/widgets", "discovering")).toMatchObject({
      repoFullName: "acme/widgets",
      state: "discovering",
    });
    expect(getRunState("acme/widgets")).toBe("discovering");

    closeDefaultRunStateStore();
    expect(getRunState("acme/widgets")).toBe("discovering");
  });

  it("rejects invalid DB paths, repo names, and run states before writing", () => {
    expect(() => initRunStateStore("   ")).toThrow("invalid_run_state_db_path");

    const dbPath = join(tempRoot(), "run-state.sqlite3");
    const store = initRunStateStore(dbPath);
    try {
      expect(() => store.getRunState("not-a-full-name")).toThrow("invalid_repo_full_name");
      expect(() => store.setRunState("owner/repo/extra", "idle")).toThrow("invalid_repo_full_name");
      expect(() => store.setRunState("owner/repo", "blocked" as never)).toThrow("invalid_run_state");
      expect(store.getRunState("owner/repo")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("fails closed to null when a legacy table contains an unknown state", () => {
    const dbPath = join(tempRoot(), "legacy.sqlite3");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE miner_run_state (
        repo_full_name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy
      .prepare("INSERT INTO miner_run_state (repo_full_name, state, updated_at) VALUES (?, ?, ?)")
      .run("acme/widgets", "paused", "2026-07-02T00:00:00.000Z");
    legacy.close();

    const store = initRunStateStore(dbPath);
    try {
      expect(store.getRunState("acme/widgets")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("listRunStates returns every recorded repo sorted by repoFullName (#4279)", () => {
    const dbPath = join(tempRoot(), "run-state.sqlite3");
    const store = initRunStateStore(dbPath);
    try {
      expect(store.listRunStates()).toEqual([]);

      store.setRunState("acme/widgets", "planning");
      store.setRunState("acme/aaa", "idle");

      const rows = store.listRunStates();
      expect(rows.map((row) => row.repoFullName)).toEqual(["acme/aaa", "acme/widgets"]);
      expect(rows[0]).toMatchObject({ repoFullName: "acme/aaa", state: "idle" });
      expect(Date.parse(rows[0]!.updatedAt)).not.toBeNaN();
    } finally {
      store.close();
    }
  });

  it("listRunStates fails closed by dropping a legacy row with an unknown state", () => {
    const dbPath = join(tempRoot(), "legacy-list.sqlite3");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE miner_run_state (
        repo_full_name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy
      .prepare("INSERT INTO miner_run_state (repo_full_name, state, updated_at) VALUES (?, ?, ?)")
      .run("acme/legacy", "paused", "2026-07-02T00:00:00.000Z");
    legacy
      .prepare("INSERT INTO miner_run_state (repo_full_name, state, updated_at) VALUES (?, ?, ?)")
      .run("acme/widgets", "planning", "2026-07-02T00:00:00.000Z");
    legacy.close();

    const store = initRunStateStore(dbPath);
    try {
      expect(store.listRunStates()).toEqual([
        { repoFullName: "acme/widgets", state: "planning", updatedAt: "2026-07-02T00:00:00.000Z" },
      ]);
    } finally {
      store.close();
    }
  });

  it("exposes the module-level listRunStates helper backed by the default local DB path", () => {
    vi.stubEnv("GITTENSORY_MINER_RUN_STATE_DB", join(tempRoot(), "default-list.sqlite3"));

    expect(listRunStates()).toEqual([]);
    setRunState("acme/widgets", "preparing");
    expect(listRunStates()).toEqual([
      expect.objectContaining({ repoFullName: "acme/widgets", state: "preparing" }),
    ]);
  });
});
