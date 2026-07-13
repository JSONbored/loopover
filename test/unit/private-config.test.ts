import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_CONFIG_CANDIDATES, isReviewSkillEnabled, localConfigCandidates, makeLocalManifestReader, makeLocalReviewContextReader, mergeConfigOverlay, parseReviewSkill, SHARED_BASE_CONFIG_CANDIDATES, type LocalManifestLoadResult } from "../../src/selfhost/private-config";
import { loadRepoReviewContext, setLocalReviewContextReader, type RepoFocusManifestFetcher } from "../../src/signals/focus-manifest-loader";
import { MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent } from "../../src/signals/focus-manifest";

async function readLocalManifestContent(reader: RepoFocusManifestFetcher, repo: string): Promise<string | null> {
  const result = await reader(repo);
  if (result === null) return null;
  return typeof result === "string" ? result : result.content;
}

async function readLocalManifestLoad(reader: RepoFocusManifestFetcher, repo: string): Promise<LocalManifestLoadResult | null> {
  const result = await reader(repo);
  if (result === null) return null;
  if (typeof result === "string") return { content: result, sharedConfigSource: null, warnings: [] };
  return result;
}

describe("localConfigCandidates (container-private config paths)", () => {
  it("builds owner-folder → repo-folder → flat candidates (lowercased), each in .yml/.yaml/.json order", () => {
    expect(localConfigCandidates("JSONbored/metagraphed")).toEqual([
      // 1. owner-qualified folder
      join("jsonbored__metagraphed", ".loopover.yml"),
      join("jsonbored__metagraphed", ".loopover.yaml"),
      join("jsonbored__metagraphed", ".loopover.json"),
      // 2. bare repo-name folder
      join("metagraphed", ".loopover.yml"),
      join("metagraphed", ".loopover.yaml"),
      join("metagraphed", ".loopover.json"),
      // 3. flat owner__repo file (#1390 back-compat)
      "jsonbored__metagraphed.yml",
      "jsonbored__metagraphed.yaml",
      "jsonbored__metagraphed.json",
    ]);
  });
  it("returns no candidates for an invalid repo full name", () => {
    expect(localConfigCandidates("no-slash")).toEqual([]); // slash < 0 → slash <= 0
    expect(localConfigCandidates("/leading")).toEqual([]); // slash at 0 → slash <= 0
    expect(localConfigCandidates("trailing/")).toEqual([]); // slash at len-1
    expect(localConfigCandidates("owner/repo/extra")).toEqual([]); // more than one slash
    expect(localConfigCandidates("owner/..")).toEqual([]);
    expect(localConfigCandidates("owner/.")).toEqual([]);
    expect(localConfigCandidates("owner/repo name")).toEqual([]);
    expect(localConfigCandidates("bad_owner/repo")).toEqual([]);
    expect(localConfigCandidates("-owner/repo")).toEqual([]);
  });
  it("exposes the dir-root global-fallback candidates", () => {
    expect(GLOBAL_CONFIG_CANDIDATES).toEqual([".loopover.yml", ".loopover.yaml", ".loopover.json"]);
  });
  it("exposes the shared-base candidates, sibling to the per-repo folders (#1959)", () => {
    expect(SHARED_BASE_CONFIG_CANDIDATES).toEqual([
      join("_shared", ".loopover.yml"),
      join("_shared", ".loopover.yaml"),
      join("_shared", ".loopover.json"),
    ]);
  });

  it("reserves the shared-base folder instead of treating it as the bare folder for a repo named _shared", () => {
    expect(localConfigCandidates("owner/_shared")).toEqual([
      join("owner___shared", ".loopover.yml"),
      join("owner___shared", ".loopover.yaml"),
      join("owner___shared", ".loopover.json"),
      "owner___shared.yml",
      "owner___shared.yaml",
      "owner___shared.json",
    ]);
  });
});

describe("mergeConfigOverlay (generic recursive deep-merge, no manifest-field-specific code)", () => {
  it("merges nested mappings key by key using generic, non-manifest field names", () => {
    expect(mergeConfigOverlay({ a: 1, b: { c: 2 } }, { b: { d: 3 } })).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });
  it("lets an override scalar replace a base scalar at the same key", () => {
    expect(mergeConfigOverlay({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });
  it("lets an override array replace a base array wholesale, never concatenated", () => {
    expect(mergeConfigOverlay({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
  it("lets an explicit override null win over any base value, including an object", () => {
    expect(mergeConfigOverlay({ a: { nested: true } }, { a: null })).toEqual({ a: null });
  });
  it("takes the override value outright when the base value at that key isn't a mergeable mapping", () => {
    expect(mergeConfigOverlay({ a: "scalar" }, { a: { nested: true } })).toEqual({ a: { nested: true } });
    expect(mergeConfigOverlay({ a: [1, 2] }, { a: { nested: true } })).toEqual({ a: { nested: true } }); // base is an array, not mergeable
    expect(mergeConfigOverlay({ a: null }, { a: { nested: true } })).toEqual({ a: { nested: true } });
  });
  it("takes the override value outright when the base has no value at that key at all", () => {
    expect(mergeConfigOverlay({}, { a: { nested: true } })).toEqual({ a: { nested: true } });
  });
  it("returns the whole override object unchanged when the top-level base isn't a mergeable mapping", () => {
    expect(mergeConfigOverlay("not-an-object", { a: 1 })).toEqual({ a: 1 });
    expect(mergeConfigOverlay(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeConfigOverlay([1, 2], { a: 1 })).toEqual({ a: 1 });
  });
  it("returns a non-mapping override value unchanged regardless of its type, ignoring base entirely", () => {
    expect(mergeConfigOverlay({ a: 1 }, "scalar")).toBe("scalar");
    expect(mergeConfigOverlay({ a: 1 }, 42)).toBe(42);
    expect(mergeConfigOverlay({ a: 1 }, true)).toBe(true);
  });
});

describe("makeLocalManifestReader (LOOPOVER_REPO_CONFIG_DIR)", () => {
  it("returns null when the dir is unset or blank (⇒ public fetch)", () => {
    expect(makeLocalManifestReader(undefined)).toBeNull(); // ?? right side
    expect(makeLocalManifestReader("")).toBeNull();
    expect(makeLocalManifestReader("   ")).toBeNull(); // blank after trim
  });

  it("reads the owner-qualified folder file first (highest-priority per-repo candidate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "jsonbored__metagraphed"));
    writeFileSync(join(dir, "jsonbored__metagraphed", ".loopover.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(reader).not.toBeNull();
    expect(await readLocalManifestContent(reader!,"JSONbored/metagraphed")).toBe("gate:\n  enabled: false\n");
  });

  it("falls back to the bare repo-name folder when no owner-qualified folder exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "metagraphed"));
    writeFileSync(join(dir, "metagraphed", ".loopover.yaml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"JSONbored/metagraphed")).toBe("gate:\n  enabled: true\n");
  });

  it("still reads the flat {owner}__{repo}.json file (#1390 back-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, "owner__repo.json"), '{"gate":{"enabled":true}}');
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe('{"gate":{"enabled":true}}');
  });

  it("falls back to the dir-root global .loopover.yml for a repo with no per-repo file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/unconfigured")).toBe("gate:\n  enabled: false\n");
  });

  it("deep-merges a per-repo file over the global default: per-repo wins on shared keys, global fills the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: false\n  duplicates: block\n"); // global
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n"); // per-repo overrides only `enabled`
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.gate.enabled).toBe(true); // per-repo wins on the shared key
    expect(manifest.gate.duplicates).toBe("block"); // inherited from global, untouched
  });

  it("replaces an array wholesale instead of concatenating it with the global default's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "wantedPaths:\n  - src/**\n  - test/**\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "wantedPaths:\n  - docs/**\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.wantedPaths).toEqual(["docs/**"]);
  });

  it("lets an explicit per-repo null clear a global-configured contributorOpenPrCap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "settings:\n  contributorOpenPrCap: 5\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "settings:\n  contributorOpenPrCap: null\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.settings.contributorOpenPrCap).toBeNull(); // explicit null clears the global 5, not "unset"
  });

  it("lets an explicit per-repo null clear a global-configured accountAgeThresholdDays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "settings:\n  accountAgeThresholdDays: 14\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "settings:\n  accountAgeThresholdDays: null\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.settings.accountAgeThresholdDays).toBeNull();
  });

  it("treats a config file over the manifest size cap as unmergeable and falls back to the other file alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    const oversized = `# ${"x".repeat(MAX_FOCUS_MANIFEST_BYTES + 10)}\ngate:\n  enabled: false\n`;
    writeFileSync(join(dir, ".loopover.yml"), oversized); // global, too large to attempt a merge against
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: true\n"); // oversized global dropped; per-repo raw text unchanged
  });

  it("falls back to the per-repo file alone when the global default fails to parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "{ not valid json"); // starts with `{` → JSON.parse throws
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: true\n");
  });

  it("falls back to the global default alone when the per-repo file parses but isn't a mapping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: false\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "[1, 2, 3]"); // valid JSON, but an array, not a mapping
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: false\n");
  });

  it("returns the per-repo raw text (today's legacy priority) when BOTH files fail to parse as mappings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "{ also broken");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "{ broken json");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("{ broken json"); // flows downstream, which warns + ignores it, same as today
  });

  it("returns null when neither a per-repo file nor a global fallback exists (⇒ loader uses the public file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/unconfigured")).toBeNull();
  });

  it("does NOT serve the global fallback to an invalid repo full name (no per-repo candidates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: false\n"); // global present
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"no-slash")).toBeNull(); // perRepo.length === 0 early return
  });

  it("rejects traversal repo names instead of reading outside the private config directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dirname(dir), ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/..")).toBeNull();
  });
});

describe("makeLocalManifestReader — shared base layer (#1959)", () => {
  it("falls back to the shared base alone when neither a per-repo file nor a global default exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: false\n"); // byte-identical raw text, no merge attempted
  });

  it("byte-identical to pre-#1959 behavior when no shared base file is mounted at all (repo-only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: true\n"); // no _shared/ present → same as the existing repo-only test
  });

  it("deep-merges a per-repo file over a shared base with no global default present: per-repo wins, shared fills the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: false\n  duplicates: block\n"); // shared house policy
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n"); // repo overrides only `enabled`
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.gate.enabled).toBe(true); // per-repo wins on the shared key
    expect(manifest.gate.duplicates).toBe("block"); // inherited from the shared base, untouched
  });

  it("folds all three layers: per-repo wins over global, which wins over the shared base, per-field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: false\n  duplicates: block\n  linkedIssue: advisory\n"); // shared house policy
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  duplicates: off\n"); // global overrides duplicates only
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n"); // per-repo overrides enabled only
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.gate.enabled).toBe(true); // from per-repo (highest priority)
    expect(manifest.gate.duplicates).toBe("off"); // from global, overlaying the shared base's "block"
    expect(manifest.gate.linkedIssue).toBe("advisory"); // inherited from the shared base, untouched by either override
  });

  it("replaces an array wholesale across the 3-layer fold instead of concatenating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "wantedPaths:\n  - shared/**\n");
    writeFileSync(join(dir, ".loopover.yml"), "wantedPaths:\n  - src/**\n  - test/**\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "wantedPaths:\n  - docs/**\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.wantedPaths).toEqual(["docs/**"]); // per-repo array wins wholesale, shared/global arrays discarded
  });

  it("lets an explicit per-repo null clear a shared-base-configured value even when global doesn't mention the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "settings:\n  contributorOpenPrCap: 5\n");
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: true\n"); // global present, but silent on contributorOpenPrCap
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "settings:\n  contributorOpenPrCap: null\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.settings.contributorOpenPrCap).toBeNull(); // explicit null clears the shared 5, not "unset"
  });

  it("fails safe to repo+global (as if unmounted) when the shared base is malformed, and never blocks a review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "{ not valid json"); // starts with `{` → JSON.parse throws
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  duplicates: block\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/repo"));
    expect(manifest.gate.enabled).toBe(true); // still merged from the two still-valid layers
    expect(manifest.gate.duplicates).toBe("block"); // global's value survives; broken shared base dropped, not blocking
  });

  it("fails safe to repo-only (shared base oversized) when it is the ONLY other layer present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    const oversized = `# ${"x".repeat(MAX_FOCUS_MANIFEST_BYTES + 10)}\ngate:\n  enabled: false\n`;
    writeFileSync(join(dir, "_shared", ".loopover.yml"), oversized); // too large to attempt a merge against
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: true\n"); // oversized shared base dropped; per-repo raw text unchanged
  });

  it("falls back to the highest-priority present layer's raw text when ALL THREE fail to parse as mappings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "{ shared also broken");
    writeFileSync(join(dir, ".loopover.yml"), "{ global also broken");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "{ broken json");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("{ broken json"); // per-repo (highest priority) raw text, same downstream "malformed" handling
  });

  it("tries _shared/.loopover.yml before .yaml before .json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yaml"), "gate:\n  enabled: true\n");
    writeFileSync(join(dir, "_shared", ".loopover.json"), '{"gate":{"enabled":false}}');
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"owner/repo")).toBe("gate:\n  enabled: true\n"); // .yaml found before .json is tried
  });

  it("keeps global precedence over the shared base for a repo named _shared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: true\nwantedPaths:\n  - '**/*'\n");
    writeFileSync(join(dir, ".loopover.yml"), "gate:\n  enabled: false\nwantedPaths:\n  - src/safe/**\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/_shared"));
    expect(manifest.gate.enabled).toBe(false); // global still overlays the reserved shared-base folder
    expect(manifest.wantedPaths).toEqual(["src/safe/**"]);
  });

  it("still supports owner-qualified config for a repo named _shared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: false\n");
    mkdirSync(join(dir, "owner___shared"));
    writeFileSync(join(dir, "owner___shared", ".loopover.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    const manifest = parseFocusManifestContent(await readLocalManifestContent(reader!,"owner/_shared"));
    expect(manifest.gate.enabled).toBe(true); // explicit owner-qualified per-repo file remains highest priority
  });

  it("does NOT serve the shared base to an invalid repo full name (no per-repo candidates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(await readLocalManifestContent(reader!,"no-slash")).toBeNull(); // perRepo.length === 0 early return, before the shared base is even read
  });
});

describe("makeLocalManifestReader — review.shared_config overlay (#2046)", () => {
  it("records sharedConfigSource when the shared base contributes a review block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review:\n  tone: shared-tone\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review:\n  profile: assertive\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    expect(loaded?.sharedConfigSource).toBe(join("_shared", ".loopover.yml"));
    const manifest = parseFocusManifestContent(loaded!.content!);
    expect(manifest.review.tone).toBe("shared-tone");
    expect(manifest.review.profile).toBe("assertive");
  });

  it("is byte-identical when the shared base is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review:\n  tone: repo-only\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    expect(loaded?.sharedConfigSource).toBeNull();
    expect(loaded?.warnings).toEqual([]);
    expect(loaded?.content).toBe("review:\n  tone: repo-only\n");
  });

  it("warns and ignores a malformed shared base while still serving higher layers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "{ broken shared");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review:\n  tone: repo-tone\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    expect(loaded?.sharedConfigSource).toBeNull();
    expect(loaded?.warnings.some((w) => w.includes("review.shared_config"))).toBe(true);
    expect(parseFocusManifestContent(loaded!.content!).review.tone).toBe("repo-tone");
  });

  it("fills review fields from the shared base when the per-repo file is silent on them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review:\n  tone: house-tone\n  security_focus: true\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "gate:\n  enabled: true\n");
    const manifest = parseFocusManifestContent((await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo"))!.content!);
    expect(manifest.review.tone).toBe("house-tone");
    expect(manifest.review.securityFocus).toBe(true);
  });

  it("lets a higher-priority review null clear an inherited shared review block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review:\n  footer:\n    text: shared footer\n  tone: house-tone\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review: null\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    const manifest = parseFocusManifestContent(loaded!.content!);
    expect(manifest.review.present).toBe(false);
    expect(manifest.review.footerText).toBeNull();
    expect(manifest.review.tone).toBeNull();
  });

  it("lets a higher-priority non-mapping review value replace an inherited shared review block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review:\n  footer:\n    text: shared footer\n  tone: house-tone\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review: false\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    const manifest = parseFocusManifestContent(loaded!.content!);
    expect(manifest.review.present).toBe(false);
    expect(manifest.review.footerText).toBeNull();
    expect(manifest.review.tone).toBeNull();
    expect(manifest.warnings).toContain('Manifest field "review" must be a mapping; ignoring it.');
  });

  it("sets sharedConfigSource when only the shared base is present for a repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review:\n  tone: only-shared\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    expect(loaded?.sharedConfigSource).toBe(join("_shared", ".loopover.yml"));
    expect(parseFocusManifestContent(loaded!.content!).review.tone).toBe("only-shared");
  });

  it("ignores a non-mapping shared review block without blocking higher layers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", ".loopover.yml"), "review: [1, 2, 3]\n");
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".loopover.yml"), "review:\n  tone: repo-tone\n");
    const loaded = await readLocalManifestLoad(makeLocalManifestReader(dir)!, "owner/repo");
    expect(parseFocusManifestContent(loaded!.content!).review.tone).toBe("repo-tone");
  });
});

describe("parseReviewSkill (#review-skills)", () => {
  it("parses frontmatter name + when (quotes stripped); body is the remainder", () => {
    expect(parseReviewSkill("sql.md", '---\nname: sql-rubric\nwhen: "**/*.sql"\n---\nCheck the index.\n')).toEqual({ name: "sql-rubric", when: "**/*.sql", body: "Check the index." });
  });
  it("defaults name to the filename and when to 'always' with no frontmatter", () => {
    expect(parseReviewSkill("voice.md", "Be decisive.")).toEqual({ name: "voice", when: "always", body: "Be decisive." });
  });
  it("treats a quotes-only/empty when as 'always'", () => {
    expect(parseReviewSkill("x.md", '---\nwhen: ""\n---\nbody').when).toBe("always");
  });
  it("strips surrounding quotes from a quoted name, symmetric with when", () => {
    // A quoted scalar is ordinary YAML frontmatter; the quotes must not survive into the skill label.
    expect(parseReviewSkill("sql.md", '---\nname: "SQL Rubric"\nwhen: "**/*.sql"\n---\nBody.\n')).toEqual({ name: "SQL Rubric", when: "**/*.sql", body: "Body." });
    // Single quotes strip too, and a quotes-only name falls back to the filename.
    expect(parseReviewSkill("y.md", "---\nname: 'Voice Guide'\n---\nb").name).toBe("Voice Guide");
    expect(parseReviewSkill("fallback.md", '---\nname: ""\n---\nb').name).toBe("fallback");
  });
  it("ignores a trailing YAML inline comment on name and when, quote-aware", () => {
    // A trailing ` # …` is a YAML comment, not part of the scalar: left in, it corrupts the label and turns
    // `when` into a glob that never matches, silently disabling the rubric.
    expect(parseReviewSkill("sql.md", '---\nname: SQL Rubric  # the sql one\nwhen: "**/*.sql"  # only sql\n---\nBody.\n')).toEqual({ name: "SQL Rubric", when: "**/*.sql", body: "Body." });
    // A `#` with no preceding whitespace is part of the value (real YAML), not a comment — must be preserved.
    expect(parseReviewSkill("cs.md", '---\nname: "C# Rubric"\n---\nb').name).toBe("C# Rubric");
    expect(parseReviewSkill("z.md", "---\nname: a#b\n---\nb").name).toBe("a#b");
    // A `#` INSIDE a quoted scalar — even with preceding whitespace — is part of the value, not a comment.
    expect(parseReviewSkill("h.md", '---\nname: "SQL #1 Rubric"\nwhen: "src/#hot/**"  # trailing note\n---\nb')).toEqual({ name: "SQL #1 Rubric", when: "src/#hot/**", body: "b" });
    // YAML-escaped double quotes and doubled single quotes are decoded, not treated as the terminator.
    expect(parseReviewSkill("e.md", '---\nname: "SQL \\"Index\\" Rubric"\n---\nb').name).toBe('SQL "Index" Rubric');
    expect(parseReviewSkill("o.md", "---\nname: 'Owner''s Rubric'\n---\nb").name).toBe("Owner's Rubric");
    // An unquoted *-leading glob is not valid standalone YAML; it must still survive as the literal when-glob.
    expect(parseReviewSkill("g.md", "---\nwhen: **/*.ts\n---\nb").when).toBe("**/*.ts");
    // A non-string YAML scalar (e.g. a bare number) falls through to the literal text rather than a typed value.
    expect(parseReviewSkill("n.md", "---\nname: 42\n---\nb").name).toBe("42");
    // A malformed unterminated quote degrades to stripping the stray leading quote (back-compat, not a crash).
    expect(parseReviewSkill("u.md", '---\nname: "unterminated\n---\nb').name).toBe("unterminated");
  });
});

describe("isReviewSkillEnabled (#review-skills)", () => {
  it("keeps a skill by default and honors an explicit enabled directive", () => {
    expect(isReviewSkillEnabled("no frontmatter at all")).toBe(true); // no frontmatter → enabled
    expect(isReviewSkillEnabled("---\nname: x\n---\nbody")).toBe(true); // frontmatter without `enabled` → enabled
    expect(isReviewSkillEnabled("---\nenabled: true\n---\nbody")).toBe(true);
    expect(isReviewSkillEnabled('---\nenabled: "on"\n---\nbody')).toBe(true); // quoted truthy stripped
    expect(isReviewSkillEnabled("---\nenabled: false\n---\nbody")).toBe(false);
    expect(isReviewSkillEnabled("---\nname: x\nenabled: no\n---\nbody")).toBe(false);
    expect(isReviewSkillEnabled("---\nenabled: 0\n---\nbody")).toBe(false); // any non-truthy value disables
  });
  it("ignores a YAML inline comment on the enabled directive", () => {
    // A trailing ` # …` is a YAML comment, not part of the value — it must not flip a truthy directive to disabled.
    expect(isReviewSkillEnabled("---\nenabled: true # temporarily explicit\n---\nbody")).toBe(true);
    expect(isReviewSkillEnabled('---\nenabled: "on"  # keep the rubric on\n---\nbody')).toBe(true); // comment after quoted value
    expect(isReviewSkillEnabled("---\nenabled: false # parked for now\n---\nbody")).toBe(false); // still disables
  });
});

describe("makeLocalReviewContextReader (#review-skills)", () => {
  it("returns null when the dir is unset/blank", () => {
    expect(makeLocalReviewContextReader(undefined)).toBeNull();
    expect(makeLocalReviewContextReader("  ")).toBeNull();
  });

  it("reads the owner-qualified review/AGENTS.md + skills/*.md (sorted, .md only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-review-"));
    const rev = join(dir, "jsonbored__gittensory", "review");
    mkdirSync(join(rev, "skills"), { recursive: true });
    writeFileSync(join(rev, "AGENTS.md"), "Review gittensory carefully.\n");
    writeFileSync(join(rev, "CLAUDE.md"), "Legacy guide should not win.\n");
    writeFileSync(join(rev, "skills", "b-second.md"), "---\nname: second\nwhen: always\n---\nSecond.\n");
    writeFileSync(join(rev, "skills", "a-first.md"), "First with no frontmatter.\n");
    writeFileSync(join(rev, "skills", "notes.txt"), "ignored — not .md\n");
    const reader = makeLocalReviewContextReader(dir)!;
    const ctx = await reader("JSONbored/gittensory");
    expect(ctx.guide).toContain("Review gittensory carefully.");
    expect(ctx.guide).not.toContain("Legacy guide should not win.");
    expect(ctx.skills.map((s) => s.name)).toEqual(["a-first", "second"]); // sorted by filename; .txt ignored
  });

  it("omits a skill whose frontmatter sets enabled: false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-review-"));
    const rev = join(dir, "jsonbored__gittensory", "review");
    mkdirSync(join(rev, "skills"), { recursive: true });
    writeFileSync(join(rev, "skills", "a-active.md"), "---\nname: active\nwhen: always\n---\nActive rubric.\n");
    writeFileSync(join(rev, "skills", "b-disabled.md"), "---\nname: disabled\nenabled: false\n---\nParked rubric.\n");
    const ctx = await makeLocalReviewContextReader(dir)!("JSONbored/gittensory");
    expect(ctx.skills.map((s) => s.name)).toEqual(["active"]); // the disabled skill is dropped, not deleted
  });

  it("falls back to legacy CLAUDE.md in the bare repo-name folder; returns empty for a missing or invalid repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-review-"));
    mkdirSync(join(dir, "metagraphed", "review"), { recursive: true });
    writeFileSync(join(dir, "metagraphed", "review", "CLAUDE.md"), "Bare-folder guide.\n");
    const reader = makeLocalReviewContextReader(dir)!;
    expect((await reader("JSONbored/metagraphed")).guide).toContain("Bare-folder guide.");
    expect(await reader("JSONbored/unknown-repo")).toEqual({ guide: null, skills: [] }); // no folder
    expect(await reader("owner/..")).toEqual({ guide: null, skills: [] }); // invalid repo segment → no candidates
    expect(await reader("noslash")).toEqual({ guide: null, skills: [] }); // invalid full name (no slash)
  });
});

describe("loadRepoReviewContext + setLocalReviewContextReader (#review-skills)", () => {
  it("empty with no reader; uses the registered reader; degrades to empty on error", async () => {
    setLocalReviewContextReader(null);
    expect(await loadRepoReviewContext("o/r")).toEqual({ guide: null, skills: [] });
    setLocalReviewContextReader(async () => ({ guide: "G", skills: [{ name: "s", when: "always", body: "B" }] }));
    expect(await loadRepoReviewContext("o/r")).toEqual({ guide: "G", skills: [{ name: "s", when: "always", body: "B" }] });
    setLocalReviewContextReader(async () => {
      throw new Error("read failed");
    });
    expect(await loadRepoReviewContext("o/r")).toEqual({ guide: null, skills: [] });
    setLocalReviewContextReader(null); // reset for other tests
  });
});
