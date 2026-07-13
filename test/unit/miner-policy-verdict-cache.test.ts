import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiPolicyVerdict } from "@jsonbored/gittensory-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initPolicyVerdictCacheStore,
  resolvePolicyVerdictCacheDbPath,
} from "../../packages/gittensory-miner/lib/policy-verdict-cache.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-policy-verdict-cache-"));
  roots.push(root);
  return join(root, "policy-verdict-cache.sqlite3");
}

function openStore(dbPath = ":memory:") {
  const store = initPolicyVerdictCacheStore(dbPath);
  stores.push(store);
  return store;
}

const REPO = "acme/widgets";
const VERDICT = { allowed: true, matchedPhrase: null, source: "AI-USAGE.md" } as const;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolvePolicyVerdictCacheDbPath (#4843)", () => {
  it("prefers the store-specific env var, then the config dir, then XDG/~config", () => {
    expect(resolvePolicyVerdictCacheDbPath({ GITTENSORY_MINER_POLICY_VERDICT_CACHE_DB: "/custom/pvc.sqlite3" })).toBe(
      "/custom/pvc.sqlite3",
    );
    expect(resolvePolicyVerdictCacheDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe(
      join("/cfg", "policy-verdict-cache.sqlite3"),
    );
    expect(resolvePolicyVerdictCacheDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "gittensory-miner", "policy-verdict-cache.sqlite3"),
    );
  });
});

describe("gittensory-miner policy-verdict cache store (#4843)", () => {
  it("returns null for a repo that has never been cached", () => {
    expect(openStore().get(REPO)).toBeNull();
  });

  it("stores and reads back a decisive doc + ETag + verdict, and reports its db path", () => {
    const store = openStore();
    const write = store.put(REPO, "AI-USAGE.md", '"v1"', VERDICT);
    expect(write).toMatchObject({ repoFullName: REPO, decisiveDoc: "AI-USAGE.md", etag: '"v1"', verdict: VERDICT });
    expect(typeof write.updatedAt).toBe("string");
    expect(store.get(REPO)).toEqual({ decisiveDoc: "AI-USAGE.md", etag: '"v1"', verdict: VERDICT });
    expect(store.dbPath).toBe(":memory:");
  });

  it("overwrites the prior entry for the same repo (ON CONFLICT upsert)", () => {
    const store = openStore();
    store.put(REPO, "AI-USAGE.md", '"v1"', VERDICT);
    const closedVerdict = { allowed: false, matchedPhrase: "no ai contributions", source: "CONTRIBUTING.md" } as const;
    store.put(REPO, "CONTRIBUTING.md", '"v2"', closedVerdict);
    expect(store.get(REPO)).toEqual({ decisiveDoc: "CONTRIBUTING.md", etag: '"v2"', verdict: closedVerdict });
  });

  it("round-trips a verdict carrying an optional fatigue field", () => {
    const store = openStore();
    const withFatigue: AiPolicyVerdict = {
      ...VERDICT,
      fatigue: { level: "watch", priorityAdjustment: "deprioritize", score: 3, recheckAfterHours: 24, evidence: [] },
    };
    store.put(REPO, "AI-USAGE.md", '"v1"', withFatigue);
    expect(store.get(REPO)?.verdict).toEqual(withFatigue);
  });

  it("rejects a non-string or empty repoFullName on both get and put", () => {
    const store = openStore();
    expect(() => store.get("")).toThrow("invalid_policy_verdict_repo_full_name");
    expect(() => store.get("   ")).toThrow("invalid_policy_verdict_repo_full_name");
    // @ts-expect-error deliberately passing a non-string to exercise the guard.
    expect(() => store.get(42)).toThrow("invalid_policy_verdict_repo_full_name");
    expect(() => store.put("", "AI-USAGE.md", '"v1"', VERDICT)).toThrow("invalid_policy_verdict_repo_full_name");
  });

  it("rejects a decisive doc outside the AI-USAGE.md/CONTRIBUTING.md pair", () => {
    const store = openStore();
    // @ts-expect-error deliberately passing an invalid decisive doc.
    expect(() => store.put(REPO, "none", '"v1"', VERDICT)).toThrow("invalid_policy_verdict_decisive_doc");
    // @ts-expect-error deliberately passing a non-string decisive doc.
    expect(() => store.put(REPO, null, '"v1"', VERDICT)).toThrow("invalid_policy_verdict_decisive_doc");
  });

  it("rejects a missing/blank ETag", () => {
    const store = openStore();
    // @ts-expect-error deliberately passing a non-string etag.
    expect(() => store.put(REPO, "AI-USAGE.md", null, VERDICT)).toThrow("invalid_policy_verdict_etag");
    expect(() => store.put(REPO, "AI-USAGE.md", "   ", VERDICT)).toThrow("invalid_policy_verdict_etag");
  });

  it("rejects a non-object verdict", () => {
    const store = openStore();
    // @ts-expect-error deliberately passing a non-object verdict.
    expect(() => store.put(REPO, "AI-USAGE.md", '"v1"', null)).toThrow("invalid_policy_verdict");
    // @ts-expect-error deliberately passing an array verdict.
    expect(() => store.put(REPO, "AI-USAGE.md", '"v1"', [])).toThrow("invalid_policy_verdict");
    // @ts-expect-error deliberately passing a string verdict.
    expect(() => store.put(REPO, "AI-USAGE.md", '"v1"', "allowed")).toThrow("invalid_policy_verdict");
  });

  it("persists entries across a close + reopen of the same on-disk file", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    store.put(REPO, "AI-USAGE.md", '"v1"', VERDICT);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openStore(dbPath);
    expect(reopened.get(REPO)).toEqual({ decisiveDoc: "AI-USAGE.md", etag: '"v1"', verdict: VERDICT });
  });

  it("resolves its default path from the env when no path is passed", () => {
    const dbPath = tempDbPath();
    vi.stubEnv("GITTENSORY_MINER_POLICY_VERDICT_CACHE_DB", dbPath);
    // Call with no argument so the default parameter resolves the path from the env.
    const store = initPolicyVerdictCacheStore();
    stores.push(store);
    expect(store.dbPath).toBe(dbPath);
  });

  it("throws on an empty explicit db path", () => {
    expect(() => initPolicyVerdictCacheStore("")).toThrow("invalid_policy_verdict_cache_db_path");
  });
});
