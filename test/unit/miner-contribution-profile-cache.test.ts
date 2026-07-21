import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTRIBUTION_PROFILE_CACHE_TTL_MS,
  CONTRIBUTION_PROFILE_STORE_TABLE,
  emptyContributionProfile,
} from "../../packages/loopover-miner/lib/contribution-profile.js";
import {
  closeDefaultContributionProfileCache,
  getCachedContributionProfile,
  initContributionProfileCache,
  putCachedContributionProfile,
  resolveContributionProfileCacheDbPath,
} from "../../packages/loopover-miner/lib/contribution-profile-cache.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-cp-cache-"));
  roots.push(root);
  const store = initContributionProfileCache(
    join(root, "nested", "contribution-profile-cache.sqlite3"),
  );
  stores.push(store);
  return store;
}

const AT_MS = Date.parse("2026-07-18T00:00:00.000Z");
const profile = (repo = "acme/widgets") =>
  emptyContributionProfile(repo, new Date(AT_MS).toISOString());

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultContributionProfileCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("contribution-profile cache store (#6797)", () => {
  it("resolves the DB path from the env override then the config-dir convention", () => {
    // The explicit-DB override is returned verbatim (platform-independent); the config-dir path is asserted by
    // suffix so the assertion is stable across `/` and `\` separators.
    expect(
      resolveContributionProfileCacheDbPath({
        LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB: "/custom/cp.sqlite3",
      }),
    ).toBe("/custom/cp.sqlite3");
    expect(
      resolveContributionProfileCacheDbPath({
        LOOPOVER_MINER_CONFIG_DIR: "/cfg",
      }),
    ).toMatch(/[/\\]cfg[/\\]contribution-profile-cache\.sqlite3$/);
  });

  it("creates the table on first use and returns null before any write", () => {
    const store = tempStore();
    expect(store.get("acme/widgets")).toBeNull();
    const db = new DatabaseSync(store.dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(CONTRIBUTION_PROFILE_STORE_TABLE);
      expect(row).toEqual({ name: CONTRIBUTION_PROFILE_STORE_TABLE });
    } finally {
      db.close();
    }
  });

  it("round-trips a stored profile and reports it fresh within the TTL", () => {
    const store = tempStore();
    const write = store.put(profile(), AT_MS);
    expect(write).toEqual({
      repoFullName: "acme/widgets",
      fetchedAt: "2026-07-18T00:00:00.000Z",
    });

    const cached = store.get(
      "acme/widgets",
      AT_MS + CONTRIBUTION_PROFILE_CACHE_TTL_MS - 1,
    );
    expect(cached).not.toBeNull();
    expect(cached!.stale).toBe(false);
    expect(cached!.fetchedAt).toBe("2026-07-18T00:00:00.000Z");
    expect(cached!.profile).toEqual(profile());
  });

  it("marks a profile stale once it is older than the TTL", () => {
    const store = tempStore();
    store.put(profile(), AT_MS);
    // Exactly at the TTL boundary is still fresh; one ms past it is stale.
    expect(
      store.get("acme/widgets", AT_MS + CONTRIBUTION_PROFILE_CACHE_TTL_MS)!
        .stale,
    ).toBe(false);
    expect(
      store.get("acme/widgets", AT_MS + CONTRIBUTION_PROFILE_CACHE_TTL_MS + 1)!
        .stale,
    ).toBe(true);
  });

  it("overwrites an existing repo's cached profile on re-put, updating the timestamp", () => {
    const store = tempStore();
    store.put(profile(), AT_MS);
    const later = AT_MS + 60_000;
    store.put(profile(), later);
    const cached = store.get("acme/widgets", later);
    expect(cached!.fetchedAt).toBe(new Date(later).toISOString());
  });

  it("keeps repos independent — one repo's profile does not leak into another", () => {
    const store = tempStore();
    store.put(profile("acme/widgets"), AT_MS);
    expect(store.get("acme/other", AT_MS)).toBeNull();
    expect(store.get("acme/widgets", AT_MS)!.profile.repoFullName).toBe(
      "acme/widgets",
    );
  });

  it("fails closed to null on a row whose JSON is corrupt, rather than throwing", () => {
    const store = tempStore();
    const db = new DatabaseSync(store.dbPath);
    db.prepare(
      `INSERT INTO ${CONTRIBUTION_PROFILE_STORE_TABLE} (repo_full_name, profile_json, fetched_at) VALUES (?, ?, ?)`,
    ).run("acme/widgets", "{not valid json", "2026-07-18T00:00:00.000Z");
    db.close();
    expect(store.get("acme/widgets", AT_MS)).toBeNull();
  });

  it("fails closed to stale on a row with an unparseable timestamp", () => {
    const store = tempStore();
    const db = new DatabaseSync(store.dbPath);
    db.prepare(
      `INSERT INTO ${CONTRIBUTION_PROFILE_STORE_TABLE} (repo_full_name, profile_json, fetched_at) VALUES (?, ?, ?)`,
    ).run("acme/widgets", JSON.stringify(profile()), "not-a-date");
    db.close();
    expect(store.get("acme/widgets", AT_MS)!.stale).toBe(true);
  });

  it("rejects an invalid DB path and invalid repo names before writing", () => {
    expect(() => initContributionProfileCache("   ")).toThrow(
      "invalid_contribution_profile_cache_db_path",
    );
    const store = tempStore();
    expect(() => store.get("not-a-full-name")).toThrow(
      "invalid_repo_full_name",
    );
    expect(() =>
      store.put({ repoFullName: "owner/repo/extra" } as never),
    ).toThrow("invalid_repo_full_name");
    expect(() => store.put({ repoFullName: 42 } as never)).toThrow(
      "invalid_repo_full_name",
    );
    // #7795: `.`/`..`/control-char segments must be rejected too (both owner and repo), not just missing/extra slashes.
    expect(() => store.get("../etc")).toThrow("invalid_repo_full_name");
    expect(() => store.get("owner/..")).toThrow("invalid_repo_full_name");
  });

  it("exposes module-level get/put helpers backed by the default DB path", () => {
    vi.stubEnv(
      "LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB",
      join(tempRootForDefault(), "default.sqlite3"),
    );
    expect(getCachedContributionProfile("acme/widgets", AT_MS)).toBeNull();
    putCachedContributionProfile(profile(), AT_MS);
    expect(
      getCachedContributionProfile("acme/widgets", AT_MS)!.profile.repoFullName,
    ).toBe("acme/widgets");
    // Closing the default store and reading again re-opens it against the same file — the data persists.
    closeDefaultContributionProfileCache();
    expect(getCachedContributionProfile("acme/widgets", AT_MS)!.stale).toBe(
      false,
    );
  });

  it("purgeByRepo deletes only the given repo's cached profile and returns the count (#7091)", () => {
    const store = tempStore();
    store.put(profile("acme/widgets"), AT_MS);
    store.put(profile("acme/other"), AT_MS);
    expect(store.purgeByRepo("acme/widgets")).toBe(1);
    expect(store.get("acme/widgets")).toBeNull();
    expect(store.get("acme/other")).not.toBeNull();
  });

  it("purgeByRepo returns 0 when the repo has no cached profile", () => {
    expect(tempStore().purgeByRepo("acme/widgets")).toBe(0);
  });
});

function tempRootForDefault(): string {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-cp-cache-default-"));
  roots.push(root);
  return root;
}
