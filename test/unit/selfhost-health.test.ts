import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import {
  backupAcknowledgedGaugeValue,
  buildHealthBody,
  codexAuthReadinessProbe,
  githubAppReadinessProbe,
  readiness,
  sqliteBackupAdvisory,
} from "../../src/selfhost/health";

describe("buildHealthBody (#2077)", () => {
  it("keeps unauthenticated liveness responses minimal", () => {
    expect(buildHealthBody()).toEqual({ status: "ok" });
  });
});

function expectDurations(result: Awaited<ReturnType<typeof readiness>>, names: string[]): void {
  expect(Object.keys(result.durationsMs).sort()).toEqual([...names].sort());
  for (const name of names) {
    expect(Number.isFinite(result.durationsMs[name])).toBe(true);
    expect(result.durationsMs[name]).toBeGreaterThanOrEqual(0);
  }
}

describe("githubAppReadinessProbe (#2497)", () => {
  it("registers no probe when neither var is set (legitimate brokered-mode deployment)", () => {
    expect(githubAppReadinessProbe(undefined, undefined, async () => "jwt")).toBeNull();
  });

  it("regression: registers a probe (and fails closed) when the App ID is set but the private key is not", async () => {
    // The original bug: gating registration on `githubAppId && githubAppPrivateKey` skipped the probe
    // entirely here, so /ready never reported this partial config as unhealthy.
    const probe = githubAppReadinessProbe("app-123", undefined, async () => "jwt");
    expect(probe).not.toBeNull();
    expect(probe!.name).toBe("github_app");
    await expect(probe!.check()).resolves.toBe(false);
  });

  it("fails closed when the private key is set but the App ID is not (the mirror partial config)", async () => {
    const probe = githubAppReadinessProbe(undefined, "test-configured-private-key", async () => "jwt");
    expect(probe).not.toBeNull();
    await expect(probe!.check()).resolves.toBe(false);
  });

  it("reports healthy when both are set and the mint succeeds", async () => {
    const probe = githubAppReadinessProbe("app-123", "test-configured-private-key", async () => "jwt");
    await expect(probe!.check()).resolves.toBe(true);
  });

  it("reports unhealthy when both are set but the mint throws (an invalid/malformed key)", async () => {
    const probe = githubAppReadinessProbe("app-123", "not-a-real-key", async () => {
      throw new Error("invalid key");
    });
    await expect(probe!.check()).resolves.toBe(false);
  });
});

describe("codexAuthReadinessProbe (#GITTENSORY-C)", () => {
  it("registers no probe when the codex reviewer opt-in is not set", () => {
    expect(codexAuthReadinessProbe({}, async () => ({ code: 0 }))).toBeNull();
    expect(
      codexAuthReadinessProbe({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "0" }, async () => ({ code: 0 })),
    ).toBeNull();
  });

  it("reports healthy only when BOTH codex --version exits 0 AND the auth file check passes", async () => {
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => ({ code: 0 }),
      async () => true,
    );
    expect(probe).not.toBeNull();
    expect(probe!.name).toBe("codex_auth");
    await expect(probe!.check()).resolves.toBe(true);
  });

  it("regression: coalesces concurrent checks and reuses the cached result", async () => {
    let versionCalls = 0;
    let resolveVersion: ((value: { code: number }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const versionStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => {
        versionCalls += 1;
        markStarted!();
        return new Promise<{ code: number }>((done) => {
          resolveVersion = done;
        });
      },
      async () => true,
    );

    const first = probe!.check();
    const second = probe!.check();
    await versionStarted;
    resolveVersion!({ code: 0 });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(probe!.check()).resolves.toBe(true);
    expect(versionCalls).toBe(1);
  });

  it("rechecks after the codex readiness cache expires", async () => {
    let versionCalls = 0;
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => {
        versionCalls += 1;
        return { code: 0 };
      },
      async () => true,
      0,
    );

    await expect(probe!.check()).resolves.toBe(true);
    await expect(probe!.check()).resolves.toBe(true);
    expect(versionCalls).toBe(2);
  });

  it("reports unhealthy when codex --version exits non-zero (missing/unauthenticated auth volume)", async () => {
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => ({ code: 1 }),
      async () => true,
    );
    await expect(probe!.check()).resolves.toBe(false);
  });

  it("fails closed (does not throw) when spawning codex itself rejects", async () => {
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => {
        throw new Error("ENOENT: codex not found");
      },
      async () => true,
    );
    await expect(probe!.check()).resolves.toBe(false);
  });

  it("regression: reports unhealthy when the auth FILE check fails even though `codex --version` succeeds", async () => {
    // The gap `codex --version` alone misses: the binary starts fine (exit 0) but no real credentials exist.
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => ({ code: 0 }),
      async () => false,
    );
    await expect(probe!.check()).resolves.toBe(false);
  });

  it("fails closed when the auth file check itself throws", async () => {
    const probe = codexAuthReadinessProbe(
      { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
      async () => ({ code: 0 }),
      async () => {
        throw new Error("EACCES");
      },
    );
    await expect(probe!.check()).resolves.toBe(false);
  });

  describe("defaultCodexAuthFileCheck (the real filesystem check)", () => {
    it("false when auth.json is missing, false when empty, true once populated — CODEX_HOME wins over HOME", async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-health-auth-"));
      const versionOk = async () => ({ code: 0 });

      const missing = codexAuthReadinessProbe({ CODEX_HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, versionOk);
      await expect(missing!.check()).resolves.toBe(false);

      writeFileSync(join(dir, "auth.json"), "");
      const empty = codexAuthReadinessProbe({ CODEX_HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, versionOk);
      await expect(empty!.check()).resolves.toBe(false);

      writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "t" }));
      const populated = codexAuthReadinessProbe({ CODEX_HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, versionOk);
      await expect(populated!.check()).resolves.toBe(true);
    });

    it("falls back to HOME/.codex/auth.json when CODEX_HOME is unset", async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-health-home-"));
      mkdirSync(join(dir, ".codex"), { recursive: true });
      writeFileSync(join(dir, ".codex", "auth.json"), JSON.stringify({ token: "t" }));
      const probe = codexAuthReadinessProbe(
        { HOME: dir, GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
        async () => ({ code: 0 }),
      );
      await expect(probe!.check()).resolves.toBe(true);
    });

    it("falls back to the literal ~/.codex/auth.json (fails safe) when neither CODEX_HOME nor HOME is set", async () => {
      const probe = codexAuthReadinessProbe(
        { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
        async () => ({ code: 0 }),
      );
      await expect(probe!.check()).resolves.toBe(false);
    });
  });
});

describe("sqliteBackupAdvisory (#8 data-safety)", () => {
  it("warns on SQLite without an acknowledged backup, and is silent otherwise", () => {
    expect(sqliteBackupAdvisory({ usingSqlite: true, backupAcknowledged: false })).toMatch(/single SQLite file with no acknowledged backup/);
    expect(sqliteBackupAdvisory({ usingSqlite: true, backupAcknowledged: true })).toBeNull(); // operator acknowledged
    expect(sqliteBackupAdvisory({ usingSqlite: false, backupAcknowledged: false })).toBeNull(); // Postgres
  });
});

describe("backupAcknowledgedGaugeValue (#2089)", () => {
  it("mirrors the advisory: 0 only when SQLite has no acknowledged backup", () => {
    expect(backupAcknowledgedGaugeValue({ usingSqlite: true, backupAcknowledged: false })).toBe(0);
    expect(backupAcknowledgedGaugeValue({ usingSqlite: true, backupAcknowledged: true })).toBe(1);
    expect(backupAcknowledgedGaugeValue({ usingSqlite: false, backupAcknowledged: false })).toBe(1);
  });
});

describe("readiness (#982)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is not ready until the migrations table has applied rows", async () => {
    const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
    const db = createD1Adapter(driver);
    // db answers but no migrations table yet → not ready
    let result = await readiness(db);
    expect(result).toMatchObject({ ok: false, checks: { db: true, migrations: false } });
    expectDurations(result, ["db", "migrations"]);
    // empty migrations table → still not ready
    driver.exec("CREATE TABLE _selfhost_migrations (name TEXT, applied_at INTEGER)");
    result = await readiness(db);
    expect(result.ok).toBe(false);
    expectDurations(result, ["db", "migrations"]);
    // an applied migration → ready
    driver.query("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)", ["0001", 0]);
    result = await readiness(db);
    expect(result).toMatchObject({ ok: true, checks: { db: true, migrations: true } });
    expectDurations(result, ["db", "migrations"]);
  });

  it("reports db=false and migrations=false when the SELECT 1 probe throws (db down)", async () => {
    const throwingDb = {
      prepare: () => ({
        bind: function() {
          return this;
        },
        first: () => Promise.reject(new Error("sqlite_io_error")),
        all: () => Promise.reject(new Error("sqlite_io_error")),
        run: () => Promise.reject(new Error("sqlite_io_error")),
        raw: () => Promise.reject(new Error("sqlite_io_error")),
      }),
      exec: () => Promise.resolve({ results: [], success: true, meta: {} }),
      batch: () => Promise.resolve([]),
      dump: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as D1Database;
    const result = await readiness(throwingDb);
    expect(result).toMatchObject({ ok: false, checks: { db: false, migrations: false } });
    expectDurations(result, ["db", "migrations"]);
  });

  it("gates readiness on configured backend probes (#4) and reports each in checks", async () => {
    const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
    const db = createD1Adapter(driver);
    driver.exec("CREATE TABLE _selfhost_migrations (name TEXT, applied_at INTEGER)");
    driver.query("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)", ["0001", 0]);
    // A healthy probe → still ready, reported in checks.
    let result = await readiness(db, [{ name: "redis", check: async () => true }]);
    expect(result).toMatchObject({ ok: true, checks: { db: true, migrations: true, redis: true } });
    expectDurations(result, ["db", "migrations", "redis"]);
    // A failing probe → NOT ready (a configured backend that's down means the instance is degraded).
    result = await readiness(db, [{ name: "redis", check: async () => false }]);
    expect(result).toMatchObject({ ok: false, checks: { db: true, migrations: true, redis: false } });
    expectDurations(result, ["db", "migrations", "redis"]);
    // A throwing probe → caught → false → not ready.
    result = await readiness(db, [
      {
        name: "qdrant",
        check: async () => {
          throw new Error("unreachable");
        },
      },
    ]);
    expect(result).toMatchObject({ ok: false, checks: { db: true, migrations: true, qdrant: false } });
    expectDurations(result, ["db", "migrations", "qdrant"]);
  });

  it("records monotonic per-probe durations for db, migrations, false probes, and throwing probes (#2078)", async () => {
    const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
    const db = createD1Adapter(driver);
    driver.exec("CREATE TABLE _selfhost_migrations (name TEXT, applied_at INTEGER)");
    driver.query("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)", ["0001", 0]);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(1000);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1004)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2007)
      .mockReturnValueOnce(3000)
      .mockReturnValueOnce(3002)
      .mockReturnValueOnce(4000)
      .mockReturnValueOnce(4009);

    const result = await readiness(db, [
      { name: "redis", check: async () => false },
      {
        name: "qdrant",
        check: async () => {
          throw new Error("unreachable");
        },
      },
    ]);

    expect(result).toEqual({
      ok: false,
      checks: { db: true, migrations: true, redis: false, qdrant: false },
      durationsMs: { db: 4, migrations: 7, redis: 2, qdrant: 9 },
    });
  });
});
