import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initPolicyDocCacheStore,
  resolvePolicyDocCacheDbPath,
} from "../../packages/gittensory-miner/lib/policy-doc-cache.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-policy-doc-cache-"));
  roots.push(root);
  return join(root, "policy-doc-cache.sqlite3");
}

function openStore(dbPath = ":memory:") {
  const store = initPolicyDocCacheStore(dbPath);
  stores.push(store);
  return store;
}

const URL = "https://api.github.com/repos/acme/widgets/contents/AI-USAGE.md";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolvePolicyDocCacheDbPath (#4842)", () => {
  it("prefers the store-specific env var, then the config dir, then XDG/~config", () => {
    expect(resolvePolicyDocCacheDbPath({ LOOPOVER_MINER_POLICY_DOC_CACHE_DB: "/custom/pdc.sqlite3" })).toBe(
      "/custom/pdc.sqlite3",
    );
    expect(resolvePolicyDocCacheDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe(
      join("/cfg", "policy-doc-cache.sqlite3"),
    );
    expect(resolvePolicyDocCacheDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "loopover-miner", "policy-doc-cache.sqlite3"),
    );
  });
});

describe("gittensory-miner policy-doc cache store (#4842)", () => {
  it("returns null for a URL that has never been cached", () => {
    expect(openStore().get(URL)).toBeNull();
  });

  it("stores and reads back an ETag + content, and reports its db path", () => {
    const store = openStore();
    const write = store.put(URL, '"v1"', "# AI usage\nwelcome");
    expect(write).toMatchObject({ url: URL, etag: '"v1"', content: "# AI usage\nwelcome" });
    expect(typeof write.updatedAt).toBe("string");
    expect(store.get(URL)).toEqual({ etag: '"v1"', content: "# AI usage\nwelcome" });
    expect(store.dbPath).toBe(":memory:");
  });

  it("overwrites the prior entry for the same URL (ON CONFLICT upsert)", () => {
    const store = openStore();
    store.put(URL, '"v1"', "old");
    store.put(URL, '"v2"', "new");
    expect(store.get(URL)).toEqual({ etag: '"v2"', content: "new" });
  });

  it("rejects a non-string or empty URL on both get and put", () => {
    const store = openStore();
    expect(() => store.get("")).toThrow("invalid_policy_doc_url");
    expect(() => store.get("   ")).toThrow("invalid_policy_doc_url");
    // @ts-expect-error deliberately passing a non-string to exercise the guard.
    expect(() => store.get(42)).toThrow("invalid_policy_doc_url");
    expect(() => store.put("", '"v1"', "x")).toThrow("invalid_policy_doc_url");
  });

  it("rejects a missing/blank ETag or a non-string content", () => {
    const store = openStore();
    // @ts-expect-error deliberately passing a non-string etag.
    expect(() => store.put(URL, null, "x")).toThrow("invalid_policy_doc_etag");
    expect(() => store.put(URL, "   ", "x")).toThrow("invalid_policy_doc_etag");
    // @ts-expect-error deliberately passing a non-string content.
    expect(() => store.put(URL, '"v1"', 123)).toThrow("invalid_policy_doc_content");
  });

  it("persists entries across a close + reopen of the same on-disk file", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    store.put(URL, '"v1"', "persisted");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openStore(dbPath);
    expect(reopened.get(URL)).toEqual({ etag: '"v1"', content: "persisted" });
  });

  it("resolves its default path from the env when no path is passed", () => {
    const dbPath = tempDbPath();
    vi.stubEnv("LOOPOVER_MINER_POLICY_DOC_CACHE_DB", dbPath);
    // Call with no argument so the default parameter resolves the path from the env.
    const store = initPolicyDocCacheStore();
    stores.push(store);
    expect(store.dbPath).toBe(dbPath);
  });

  it("throws on an empty explicit db path", () => {
    expect(() => initPolicyDocCacheStore("")).toThrow("invalid_policy_doc_cache_db_path");
  });
});
