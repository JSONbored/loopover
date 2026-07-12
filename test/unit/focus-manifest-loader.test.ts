import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import type { JsonValue } from "../../src/types";
import {
  fetchRepoFocusManifestFile,
  loadPublicRepoFocusManifest,
  loadRepoFocusManifest,
  loadRepoFocusManifests,
  setLocalManifestReader,
  upsertRepoFocusManifest,
  REPO_FOCUS_MANIFEST_MAX_AGE_MS,
  REPO_FOCUS_MANIFEST_MAX_CONCURRENT_LOADS,
  REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL,
} from "../../src/signals/focus-manifest-loader";
import { MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent } from "../../src/signals/focus-manifest";

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

  it("preserves review.instructions across the repo-file cache round trip", async () => {
    const env = createTestEnv();
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return JSON.stringify({ review: { instructions: "Follow our async-error conventions." } });
    };

    const first = await loadRepoFocusManifest(env, "owner/review-instructions", { fetcher });
    expect(first.review.instructions).toBe("Follow our async-error conventions.");

    const second = await loadRepoFocusManifest(env, "owner/review-instructions", { fetcher });
    expect(fetches).toBe(1);
    expect(second.review.instructions).toBe("Follow our async-error conventions.");
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

  it("ignores API-backed records when loading a public-only repo manifest", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "owner/public-only", { wantedPaths: ["private/"], gate: { linkedIssue: "block", readinessMinScore: 99 } });

    const manifest = await loadPublicRepoFocusManifest(env, "owner/public-only", {
      fetcher: async () => JSON.stringify({ wantedPaths: ["src/"], gate: { linkedIssue: "advisory" } }),
    });

    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["src/"]);
    expect(manifest.gate.linkedIssue).toBe("advisory");
    expect(manifest.gate.readinessMinScore).toBeNull();
  });

  it("falls back to safe public defaults when only an API-backed record exists", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "owner/no-public-file", { gate: { linkedIssue: "block", readinessMinScore: 99 } });

    const manifest = await loadPublicRepoFocusManifest(env, "owner/no-public-file", { fetcher: async () => null });

    expect(manifest.present).toBe(false);
    expect(manifest.source).toBe("none");
    expect(manifest.gate.linkedIssue).toBeNull();
    expect(manifest.gate.readinessMinScore).toBeNull();
  });

  it("does not let public-only loads overwrite API-backed private manifests", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "owner/private-gates", {
      wantedPaths: ["private/"],
      gate: { linkedIssue: "block", readinessMinScore: 99 },
    });

    const publicManifest = await loadPublicRepoFocusManifest(env, "owner/private-gates", {
      fetcher: async () => JSON.stringify({ wantedPaths: ["public/"], gate: { linkedIssue: "advisory" } }),
    });
    const privateManifest = await loadRepoFocusManifest(env, "owner/private-gates", {
      fetcher: async () => {
        throw new Error("should keep using the API-backed private manifest");
      },
    });

    expect(publicManifest.source).toBe("repo_file");
    expect(publicManifest.wantedPaths).toEqual(["public/"]);
    expect(privateManifest.source).toBe("api_record");
    expect(privateManifest.wantedPaths).toEqual(["private/"]);
    expect(privateManifest.gate.linkedIssue).toBe("block");
  });

  it("caches public-only repo-file manifests without touching private/API-backed records", async () => {
    const env = createTestEnv();
    let fetches = 0;
    const first = await loadPublicRepoFocusManifest(env, "owner/public-cache", {
      fetcher: async () => {
        fetches += 1;
        return JSON.stringify({ wantedPaths: ["public/"] });
      },
    });
    const second = await loadPublicRepoFocusManifest(env, "owner/public-cache", {
      fetcher: async () => {
        throw new Error("should use the public-only cache");
      },
    });

    expect(fetches).toBe(1);
    expect(first.source).toBe("repo_file");
    expect(second.wantedPaths).toEqual(["public/"]);
  });

  it("negative-caches absent public-only manifests in the public cache stream", async () => {
    const env = createTestEnv();
    await loadPublicRepoFocusManifest(env, "owner/no-public-cache", { fetcher: async () => null });
    const { listSignalSnapshots } = await import("../../src/db/repositories");
    const snapshots = await listSignalSnapshots(env, REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL, "owner/no-public-cache");
    expect(snapshots).toHaveLength(1);

    let fetches = 0;
    const cached = await loadPublicRepoFocusManifest(env, "owner/no-public-cache", {
      fetcher: async () => {
        fetches += 1;
        return JSON.stringify({ wantedPaths: ["unexpected/"] });
      },
    });
    expect(fetches).toBe(0);
    expect(cached.present).toBe(false);
    expect(cached.source).toBe("none");
  });

  it("ignores unknown-source legacy snapshots on public-only manifest loads", async () => {
    const env = createTestEnv();
    const { persistSignalSnapshot } = await import("../../src/db/repositories");
    const { REPO_FOCUS_MANIFEST_SIGNAL } = await import("../../src/signals/focus-manifest-loader");
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/legacy-unknown",
      repoFullName: "owner/legacy-unknown",
      payload: { wantedPaths: ["unknown-source/"] },
      generatedAt: new Date().toISOString(),
    });

    const manifest = await loadPublicRepoFocusManifest(env, "owner/legacy-unknown", {
      fetcher: async () => JSON.stringify({ wantedPaths: ["repo-file/"] }),
    });

    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["repo-file/"]);
  });

  it("ignores API-backed snapshots in the public cache stream", async () => {
    const env = createTestEnv();
    const { persistSignalSnapshot } = await import("../../src/db/repositories");
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_PUBLIC_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/public-api-cache",
      repoFullName: "owner/public-api-cache",
      payload: { source: "api_record", wantedPaths: ["private/"], gate: { linkedIssue: "block", readinessMinScore: 99 } },
      generatedAt: new Date().toISOString(),
    });

    const manifest = await loadPublicRepoFocusManifest(env, "owner/public-api-cache", {
      fetcher: async () => JSON.stringify({ wantedPaths: ["repo-file/"], gate: { linkedIssue: "advisory" } }),
    });

    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["repo-file/"]);
    expect(manifest.gate.linkedIssue).toBe("advisory");
  });

  it("accepts explicit repo-file legacy snapshots on public-only manifest loads", async () => {
    const env = createTestEnv();
    const { persistSignalSnapshot } = await import("../../src/db/repositories");
    const { REPO_FOCUS_MANIFEST_SIGNAL } = await import("../../src/signals/focus-manifest-loader");
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/legacy-repo-file",
      repoFullName: "owner/legacy-repo-file",
      payload: { source: "repo_file", wantedPaths: ["legacy-repo-file/"] },
      generatedAt: new Date().toISOString(),
    });

    const manifest = await loadPublicRepoFocusManifest(env, "owner/legacy-repo-file", {
      fetcher: async () => {
        throw new Error("explicit repo-file legacy snapshot should be reused");
      },
    });

    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["legacy-repo-file/"]);
  });

  it("bulk-loads manifests for many repos with a concurrency cap", async () => {
    const env = createTestEnv();
    let active = 0;
    let maxActive = 0;
    const fetcher = async (repoFullName: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return repoFullName === "owner/a"
        ? JSON.stringify({ wantedPaths: ["src/"] })
        : repoFullName === "owner/b"
          ? JSON.stringify({ preferredLabels: ["feature"] })
          : null;
    };
    const repos = ["owner/a", "owner/b", "owner/c", "owner/d", "owner/e", "owner/f"];
    const map = await loadRepoFocusManifests(env, repos, { fetcher });
    expect(map.get("owner/a")?.wantedPaths).toEqual(["src/"]);
    expect(map.get("owner/b")?.preferredLabels).toEqual(["feature"]);
    expect(map.get("owner/c")?.present).toBe(false);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(REPO_FOCUS_MANIFEST_MAX_CONCURRENT_LOADS);
  });

  it("rejects an invalid repoFullName from the public fetcher without throwing", async () => {
    expect(await fetchRepoFocusManifestFile("")).toBeNull();
    expect(await fetchRepoFocusManifestFile("no-slash")).toBeNull();
    expect(await fetchRepoFocusManifestFile("trailing/")).toBeNull();
  });

  it("returns raw text from the first 200 OK candidate path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const stringUrl = String(url);
      if (stringUrl.endsWith("/.gittensory.yml")) return new Response("wantedPaths:\n  - src/\n", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const text = await fetchRepoFocusManifestFile("owner/repo");
    expect(text).toBe("wantedPaths:\n  - src/\n");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not read public manifest responses when Content-Length is too large", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const stringUrl = String(url);
      if (stringUrl.endsWith("/.gittensory.yml") || stringUrl.endsWith("/.github/gittensory.yml")) {
        return new Response("not found", { status: 404 });
      }
      if (stringUrl.endsWith("/.gittensory.json")) {
        return new Response('{"wantedPaths":["too-large/"]}', {
          status: 200,
          headers: { "content-length": String(MAX_FOCUS_MANIFEST_BYTES + 1) },
        });
      }
      return new Response('{"wantedPaths":["src/"]}', { status: 200 });
    });
    const text = await fetchRepoFocusManifestFile("owner/repo");
    expect(text).toBe('{"wantedPaths":["src/"]}');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("aborts public manifest streams that grow beyond the byte cap", async () => {
    const oversizedChunk = new Uint8Array(MAX_FOCUS_MANIFEST_BYTES + 1);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversizedChunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    expect(await fetchRepoFocusManifestFile("owner/repo")).toBeNull();
  });

  it("rejects oversized raw manifest content before JSON parsing", () => {
    const manifest = parseFocusManifestContent(`{ "wantedPaths": ["${"a".repeat(MAX_FOCUS_MANIFEST_BYTES)}"] }`);
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/exceeded/);
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
      return new Response('{"wantedPaths":["src/"]}', { status: 200 });
    });
    const text = await fetchRepoFocusManifestFile("owner/repo");
    expect(text).toBe('{"wantedPaths":["src/"]}');
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

  it("falls back to bundled YAML for a configured self-repo alias when fetch is unavailable", async () => {
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "fork/gittensory" });
    const manifest = await loadRepoFocusManifest(env, "fork/gittensory", { fetcher: async () => null });
    expect(manifest.present).toBe(true);
    expect(manifest.wantedPaths).toContain("apps/gittensory-ui/");
  });

  it("negative-caches an absent manifest so the gate path does not re-fetch every webhook", async () => {
    const env = createTestEnv();
    await loadRepoFocusManifest(env, "owner/empty", { fetcher: async () => null });
    const { listSignalSnapshots } = await import("../../src/db/repositories");
    const { REPO_FOCUS_MANIFEST_SIGNAL } = await import("../../src/signals/focus-manifest-loader");
    const snapshots = await listSignalSnapshots(env, REPO_FOCUS_MANIFEST_SIGNAL, "owner/empty");
    expect(snapshots).toHaveLength(1);
    // A second load returns the cached absent manifest without invoking the fetcher again.
    let fetches = 0;
    const cached = await loadRepoFocusManifest(env, "owner/empty", {
      fetcher: async () => {
        fetches += 1;
        return null;
      },
    });
    expect(fetches).toBe(0);
    expect(cached.present).toBe(false);
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

  it("treats a cached array payload as a repo-file snapshot without an explicit api_record source", async () => {
    const env = createTestEnv();
    const { persistSignalSnapshot } = await import("../../src/db/repositories");
    const { REPO_FOCUS_MANIFEST_SIGNAL } = await import("../../src/signals/focus-manifest-loader");
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_FOCUS_MANIFEST_SIGNAL,
      targetKey: "owner/array-payload",
      repoFullName: "owner/array-payload",
      payload: ["wantedPaths", "src/"] as unknown as Record<string, JsonValue>,
      generatedAt: new Date().toISOString(),
    });
    const manifest = await loadRepoFocusManifest(env, "owner/array-payload", {
      fetcher: async () => {
        throw new Error("should not fetch when a fresh repo-file cache snapshot exists");
      },
    });
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/mapping/i);
  });
});

describe("focus-manifest loader — container-private config (self-host)", () => {
  afterEach(() => setLocalManifestReader(null));

  it("prefers the registered local reader over the public fetcher and tags it api_record", async () => {
    const env = createTestEnv();
    let fetched = 0;
    setLocalManifestReader(async (repo) => (repo === "owner/private" ? "wantedPaths:\n  - private/\n" : null));
    const manifest = await loadRepoFocusManifest(env, "owner/private", {
      fetcher: async () => {
        fetched += 1;
        return JSON.stringify({ wantedPaths: ["public/"] });
      },
    });
    expect(manifest.source).toBe("api_record");
    expect(manifest.wantedPaths).toEqual(["private/"]);
    expect(fetched).toBe(0); // the public `.gittensory.yml` was never fetched
  });

  it("falls through to the public fetcher when the local reader has no file for the repo", async () => {
    const env = createTestEnv();
    let fetched = 0;
    setLocalManifestReader(async () => null);
    const manifest = await loadRepoFocusManifest(env, "owner/public", {
      fetcher: async () => {
        fetched += 1;
        return JSON.stringify({ wantedPaths: ["src/"] });
      },
    });
    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["src/"]);
    expect(fetched).toBe(1);
  });

  it("never consults the local reader on the publicOnly (contributor-preview) path", async () => {
    const env = createTestEnv();
    let localCalls = 0;
    setLocalManifestReader(async () => {
      localCalls += 1;
      return "wantedPaths:\n  - private/\n";
    });
    const manifest = await loadPublicRepoFocusManifest(env, "owner/preview", {
      fetcher: async () => JSON.stringify({ wantedPaths: ["src/"] }),
    });
    expect(localCalls).toBe(0); // private config must never leak into a contributor-facing preview
    expect(manifest.source).toBe("repo_file");
    expect(manifest.wantedPaths).toEqual(["src/"]);
  });

  it("threads review.shared_config provenance from the local reader into the parsed manifest (#2046)", async () => {
    const env = createTestEnv();
    setLocalManifestReader(async () => ({
      content: JSON.stringify({ review: { profile: "assertive" } }),
      sharedConfigSource: "_shared/.gittensory.yml",
      warnings: [],
    }));
    const manifest = await loadRepoFocusManifest(env, "owner/private");
    expect(manifest.review.profile).toBe("assertive");
    expect(manifest.review.sharedConfigSource).toBe("_shared/.gittensory.yml");
  });

  it("appends private-config warnings without sharedConfigSource (#2046)", async () => {
    const env = createTestEnv();
    setLocalManifestReader(async () => ({
      content: "wantedPaths:\n  - src/\n",
      sharedConfigSource: null,
      warnings: ["Container-private shared base manifest (`review.shared_config`) is malformed or oversized; ignoring it and continuing (#2046)."],
    }));
    const manifest = await loadRepoFocusManifest(env, "owner/private");
    expect(manifest.wantedPaths).toEqual(["src/"]);
    expect(manifest.review.sharedConfigSource).toBeNull();
    expect(manifest.warnings).toContain(
      "Container-private shared base manifest (`review.shared_config`) is malformed or oversized; ignoring it and continuing (#2046).",
    );
  });

  it("surfaces the gate.enabled/checkMode ambiguity warning from a private-config `gate:` block (#5355)", async () => {
    // The real 2026-07 incident: an operator's private VPS config set gate.enabled without gate.checkMode.
    // loadPublicRepoFocusManifest (the PR-comment path) never consults the local reader at all -- so this
    // warning can only ever reach a human through loadRepoFocusManifest, i.e. the maintainer-gated
    // /v1/repos/:owner/:repo/focus-manifest API route. Lock in that the private config's own `gate.enabled`
    // reaches the loader's returned manifest.warnings, not just the public repo_file path.
    const env = createTestEnv();
    setLocalManifestReader(async () => "gate:\n  enabled: true\n");
    const manifest = await loadRepoFocusManifest(env, "owner/private");
    expect(manifest.gate.enabled).toBe(true);
    expect(manifest.gate.checkMode).toBeNull();
    expect(manifest.warnings.some((w) => /gate\.enabled.*only controls whether the LoopOver Orb Review Agent check-run publishes/.test(w))).toBe(true);
  });
});
