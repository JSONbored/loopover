import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_RUN_MANIFEST,
  DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES,
  parseFleetRunManifest,
  parseFleetRunManifestContent,
} from "../../packages/loopover-engine/src/index";

describe("FleetRunManifest parser (#4299)", () => {
  it("re-exports the parser API from the engine barrel", () => {
    expect(typeof parseFleetRunManifest).toBe("function");
    expect(typeof parseFleetRunManifestContent).toBe("function");
  });

  it("treats missing raw input as an absent safe-default manifest", () => {
    for (const raw of [undefined, null]) {
      expect(parseFleetRunManifest(raw)).toEqual({ present: false, manifest: DEFAULT_FLEET_RUN_MANIFEST, warnings: [] });
    }
  });

  it.each(["not a mapping", ["still", "not", "a", "mapping"]])("degrades a malformed top-level value to safe defaults: %j", (raw) => {
    const parsed = parseFleetRunManifest(raw);
    expect(parsed.present).toBe(false);
    expect(parsed.manifest).toEqual(DEFAULT_FLEET_RUN_MANIFEST);
    expect(parsed.warnings.join(" ")).toMatch(/must be a mapping/i);
  });

  it("treats an all-default mapping as absent (no non-default fields)", () => {
    const parsed = parseFleetRunManifest({ repos: [], totalConcurrentWorktrees: 1 });
    expect(parsed.present).toBe(false);
    expect(parsed.warnings.join(" ")).toMatch(/no recognized non-default fields/i);
  });

  it("normalizes string + object repo entries, floors budgets, dedupes, and skips invalid entries", () => {
    const parsed = parseFleetRunManifest({
      repos: [
        "owner/a", // string → default budget 1
        { repoFullName: "owner/b", maxConcurrentWorktrees: 3.9 }, // object → floored to 3
        { repoFullName: "owner/b", maxConcurrentWorktrees: 2 }, // duplicate → skipped
        "owner/a", // duplicate → skipped
        "not-a-repo", // invalid name (no slash) → skipped
        "owner/repo/extra", // invalid name (too many slashes) → skipped
        "/only-repo", // invalid name (empty owner) → skipped
        { repoFullName: "no-slash" }, // invalid name → skipped
        { repoFullName: 123 }, // non-string repoFullName → skipped
        { repoFullName: "owner/c", maxConcurrentWorktrees: "x" }, // non-numeric budget → default 1 + warning
        42, // non-string / non-mapping → skipped
      ],
      totalConcurrentWorktrees: 5,
    });
    expect(parsed.present).toBe(true);
    expect(parsed.manifest.repos).toEqual([
      { repoFullName: "owner/a", maxConcurrentWorktrees: 1 },
      { repoFullName: "owner/b", maxConcurrentWorktrees: 3 },
      { repoFullName: "owner/c", maxConcurrentWorktrees: 1 },
    ]);
    expect(parsed.manifest.totalConcurrentWorktrees).toBe(5);
    const w = parsed.warnings.join(" ");
    expect(w).toMatch(/duplicate entry for owner\/b/);
    expect(w).toMatch(/invalid "owner\/repo" name/);
    expect(w).toMatch(/non-string, non-mapping/);
    expect(w).toMatch(/"maxConcurrentWorktrees" must be a positive whole number/);
  });

  it("derives both bare-string and object-form per-repo defaults from the dedicated per-repo constant, decoupled from the fleet-wide total default", () => {
    // The per-repo default is its own source of truth, deliberately distinct from the fleet-wide total default.
    // Both equal 1 today, so this pins the value once and lets the assertions below reference the constant rather
    // than a bare `1` — a future change to the fleet-wide total default cannot silently move the per-repo default.
    expect(DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES).toBe(1);

    // The frozen DEFAULT_FLEET_RUN_MANIFEST.totalConcurrentWorktrees can't be mutated in place, so drive a
    // non-default fleet-wide total through the manifest input instead: a bare-string entry (no budget of its own)
    // and an object-form entry (budget omitted) must BOTH still fall back to the dedicated per-repo constant, not
    // the manifest's fleet-wide total.
    const parsed = parseFleetRunManifest({
      repos: ["owner/a", { repoFullName: "owner/b" }],
      totalConcurrentWorktrees: 7,
    });
    expect(parsed.present).toBe(true);
    expect(parsed.manifest.totalConcurrentWorktrees).toBe(7);
    expect(parsed.manifest.repos).toEqual([
      { repoFullName: "owner/a", maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES },
      { repoFullName: "owner/b", maxConcurrentWorktrees: DEFAULT_FLEET_RUN_MANIFEST_REPO_MAX_CONCURRENT_WORKTREES },
    ]);
    // The per-repo default did not inherit the non-default fleet-wide total.
    expect(parsed.manifest.repos.every((r) => r.maxConcurrentWorktrees !== parsed.manifest.totalConcurrentWorktrees)).toBe(true);
  });

  it("falls a non-list repos field and a sub-1 total budget back to defaults with warnings", () => {
    const parsed = parseFleetRunManifest({ repos: "owner/a", totalConcurrentWorktrees: 0 });
    expect(parsed.manifest.repos).toEqual([]);
    expect(parsed.manifest.totalConcurrentWorktrees).toBe(1);
    const w = parsed.warnings.join(" ");
    expect(w).toMatch(/"repos" must be a list/);
    expect(w).toMatch(/"totalConcurrentWorktrees" must be >= 1/);
  });

  it("warns on a non-numeric total budget", () => {
    const parsed = parseFleetRunManifest({ repos: ["owner/a"], totalConcurrentWorktrees: "lots" });
    expect(parsed.present).toBe(true);
    expect(parsed.manifest.totalConcurrentWorktrees).toBe(1);
    expect(parsed.warnings.join(" ")).toMatch(/"totalConcurrentWorktrees" must be a positive whole number/);
  });

  it("caps the repo list and warns when it is exceeded", () => {
    const many = Array.from({ length: 502 }, (_, i) => `owner/r${i}`);
    const parsed = parseFleetRunManifest({ repos: many });
    expect(parsed.manifest.repos).toHaveLength(500);
    expect(parsed.warnings.join(" ")).toMatch(/exceeded 500 entries/);
  });

  it("parseFleetRunManifestContent: blank / missing content is an absent manifest", () => {
    for (const content of [undefined, null, "", "   "]) {
      expect(parseFleetRunManifestContent(content)).toEqual({ present: false, manifest: DEFAULT_FLEET_RUN_MANIFEST, warnings: [] });
    }
  });

  it("parseFleetRunManifestContent: parses YAML and JSON, over-limit + malformed degrade with a warning", () => {
    const yaml = parseFleetRunManifestContent("repos:\n  - owner/a\n  - repoFullName: owner/b\n    maxConcurrentWorktrees: 2\ntotalConcurrentWorktrees: 4\n");
    expect(yaml.present).toBe(true);
    expect(yaml.manifest.repos.map((r) => r.repoFullName)).toEqual(["owner/a", "owner/b"]);
    expect(yaml.manifest.totalConcurrentWorktrees).toBe(4);

    const json = parseFleetRunManifestContent('{"repos":["owner/a"],"totalConcurrentWorktrees":3}');
    expect(json.present).toBe(true);
    expect(json.manifest.totalConcurrentWorktrees).toBe(3);

    // multi-byte content (still under the byte limit) exercises the byte-length accounting.
    expect(parseFleetRunManifestContent("totalConcurrentWorktrees: 2 # é中\u{1F600}").manifest.totalConcurrentWorktrees).toBe(2);

    expect(parseFleetRunManifestContent('{"repos": [invalid json}').warnings.join(" ")).toMatch(/not valid JSON/);
    expect(parseFleetRunManifestContent("repos:\n  - : :\n :bad").warnings.join(" ")).toMatch(/not valid YAML/);
    expect(parseFleetRunManifestContent("x".repeat(65_537)).warnings.join(" ")).toMatch(/exceeded 65536 bytes/);
  });
});
