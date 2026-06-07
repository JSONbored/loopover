import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import {
  fetchRepoFocusManifestFile,
  loadRepoFocusManifest,
  loadRepoFocusManifests,
  upsertRepoFocusManifest,
  REPO_FOCUS_MANIFEST_MAX_AGE_MS,
} from "../../src/signals/focus-manifest-loader";

describe("focus-manifest loader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ingests a repo-owned manifest from a stubbed fetcher and caches it", async () => {
    const env = createTestEnv();
    const fetched: string[] = [];
    const fetcher = async (repoFullName: string) => {
      fetched.push(repoFullName);
      return JSON.stringify({ wantedPaths: ["src/"], linkedIssuePolicy: "required" });
    };
    const first = await loadRepoFocusManifest(env, "owner/repo", { fetcher });
    expect(first.present).toBe(true);
    expect(first.source).toBe("repo_file");
    expect(first.wantedPaths).toEqual(["src/"]);
    expect(first.linkedIssuePolicy).toBe("required");
    expect(fetched).toEqual(["owner/repo"]);

    // Second call should hit the cached snapshot, not the fetcher.
    const second = await loadRepoFocusManifest(env, "owner/repo", { fetcher });
    expect(second.wantedPaths).toEqual(["src/"]);
    expect(fetched).toEqual(["owner/repo"]);
  });

  it("falls back to an empty manifest when no repo file is published and never throws", async () => {
    const env = createTestEnv();
    const manifest = await loadRepoFocusManifest(env, "owner/missing", { fetcher: async () => null });
    expect(manifest.present).toBe(false);
    expect(manifest.source).toBe("none");
  });

  it("survives a fetcher that throws", async () => {
    const env = createTestEnv();
    const manifest = await loadRepoFocusManifest(env, "owner/broken", {
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    expect(manifest.present).toBe(false);
  });

  it("warns instead of crashing on malformed manifest content", async () => {
    const env = createTestEnv();
    const manifest = await loadRepoFocusManifest(env, "owner/malformed", { fetcher: async () => "{ broken json" });
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid JSON/i);
  });

  it("re-fetches when the cached snapshot is older than the max age", async () => {
    const env = createTestEnv();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return JSON.stringify({ wantedPaths: ["src/"] });
    };
    await loadRepoFocusManifest(env, "owner/stale", { fetcher });
    expect(calls).toBe(1);
    await loadRepoFocusManifest(env, "owner/stale", { fetcher, maxAgeMs: -1 });
    expect(calls).toBe(2);
  });

  it("supports an API-backed persisted manifest record", async () => {
    const env = createTestEnv();
    const saved = await upsertRepoFocusManifest(env, "owner/api", { wantedPaths: ["lib/"] });
    expect(saved.present).toBe(true);
    expect(saved.source).toBe("api_record");
    // API-backed settings snapshots are durable and do not age out like repo-file fetch caches.
    const reloaded = await loadRepoFocusManifest(env, "owner/api", {
      maxAgeMs: -1,
      fetcher: async () => {
        throw new Error("should not be called");
      },
    });
    expect(reloaded.wantedPaths).toEqual(["lib/"]);
    expect(reloaded.source).toBe("api_record");
  });

  it("bulk-loads manifests for many repos in parallel", async () => {
    const env = createTestEnv();
    const fetcher = async (repoFullName: string) =>
      repoFullName === "owner/a"
        ? JSON.stringify({ wantedPaths: ["src/"] })
        : repoFullName === "owner/b"
          ? JSON.stringify({ blockedPaths: ["dist/"] })
          : null;
    const map = await loadRepoFocusManifests(env, ["owner/a", "owner/b", "owner/c"], { fetcher });
    expect(map.get("owner/a")?.wantedPaths).toEqual(["src/"]);
    expect(map.get("owner/b")?.blockedPaths).toEqual(["dist/"]);
    expect(map.get("owner/c")?.present).toBe(false);
  });

  it("rejects an invalid repoFullName from the public fetcher without throwing", async () => {
    expect(await fetchRepoFocusManifestFile("")).toBeNull();
    expect(await fetchRepoFocusManifestFile("no-slash")).toBeNull();
    expect(await fetchRepoFocusManifestFile("trailing/")).toBeNull();
  });

  it("returns raw text from the first 200 OK candidate path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const stringUrl = String(url);
      if (stringUrl.endsWith("/.gittensory.json")) return new Response("not found", { status: 404 });
      if (stringUrl.endsWith("/.github/gittensory.json")) return new Response('{"wantedPaths":["src/"]}', { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const text = await fetchRepoFocusManifestFile("owner/repo");
    expect(text).toBe('{"wantedPaths":["src/"]}');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null when every candidate path responds non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 404 }));
    expect(await fetchRepoFocusManifestFile("owner/repo")).toBeNull();
  });

  it("ignores a fetch that throws and continues to the next candidate", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("network down");
      return new Response('{"blockedPaths":["dist/"]}', { status: 200 });
    });
    const text = await fetchRepoFocusManifestFile("owner/repo");
    expect(text).toBe('{"blockedPaths":["dist/"]}');
  });

  it("exposes a reasonable default max-age", () => {
    expect(REPO_FOCUS_MANIFEST_MAX_AGE_MS).toBeGreaterThan(60 * 1000);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const env = createTestEnv();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return JSON.stringify({ wantedPaths: ["src/"] });
    };
    await loadRepoFocusManifest(env, "owner/refresh", { fetcher });
    expect(calls).toBe(1);
    await loadRepoFocusManifest(env, "owner/refresh", { fetcher, refresh: true });
    expect(calls).toBe(2);
  });

  it("treats a cached snapshot with a missing or unparseable timestamp as stale", async () => {
    const env = createTestEnv();
    const { persistSignalSnapshot } = await import("../../src/db/repositories");
    const { REPO_FOCUS_MANIFEST_SIGNAL } = await import("../../src/signals/focus-manifest-loader");
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/notime",
      repoFullName: "owner/notime",
      payload: { wantedPaths: ["old/"] },
      generatedAt: "not-a-date",
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/emptytime",
      repoFullName: "owner/emptytime",
      payload: { wantedPaths: ["old/"] },
      generatedAt: "",
    });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return JSON.stringify({ wantedPaths: ["fresh/"] });
    };
    const unparseable = await loadRepoFocusManifest(env, "owner/notime", { fetcher });
    expect(unparseable.wantedPaths).toEqual(["fresh/"]);
    const emptyTime = await loadRepoFocusManifest(env, "owner/emptytime", { fetcher });
    expect(emptyTime.wantedPaths).toEqual(["fresh/"]);
    expect(calls).toBe(2);
  });
});
