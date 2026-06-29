import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_CONFIG_CANDIDATES, localConfigCandidates, makeLocalManifestReader, makeLocalReviewContextReader, parseReviewSkill } from "../../src/selfhost/private-config";
import { loadRepoReviewContext, setLocalReviewContextReader } from "../../src/signals/focus-manifest-loader";

describe("localConfigCandidates (container-private config paths)", () => {
  it("builds owner-folder → repo-folder → flat candidates (lowercased), each in .yml/.yaml/.json order", () => {
    expect(localConfigCandidates("JSONbored/metagraphed")).toEqual([
      // 1. owner-qualified folder
      join("jsonbored__metagraphed", ".gittensory.yml"),
      join("jsonbored__metagraphed", ".gittensory.yaml"),
      join("jsonbored__metagraphed", ".gittensory.json"),
      // 2. bare repo-name folder
      join("metagraphed", ".gittensory.yml"),
      join("metagraphed", ".gittensory.yaml"),
      join("metagraphed", ".gittensory.json"),
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
    expect(GLOBAL_CONFIG_CANDIDATES).toEqual([".gittensory.yml", ".gittensory.yaml", ".gittensory.json"]);
  });
});

describe("makeLocalManifestReader (GITTENSORY_REPO_CONFIG_DIR)", () => {
  it("returns null when the dir is unset or blank (⇒ public fetch)", () => {
    expect(makeLocalManifestReader(undefined)).toBeNull(); // ?? right side
    expect(makeLocalManifestReader("")).toBeNull();
    expect(makeLocalManifestReader("   ")).toBeNull(); // blank after trim
  });

  it("reads the owner-qualified folder file first (highest-priority per-repo candidate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "jsonbored__metagraphed"));
    writeFileSync(join(dir, "jsonbored__metagraphed", ".gittensory.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(reader).not.toBeNull();
    expect(await reader!("JSONbored/metagraphed")).toBe("gate:\n  enabled: false\n");
  });

  it("falls back to the bare repo-name folder when no owner-qualified folder exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    mkdirSync(join(dir, "metagraphed"));
    writeFileSync(join(dir, "metagraphed", ".gittensory.yaml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("JSONbored/metagraphed")).toBe("gate:\n  enabled: true\n");
  });

  it("still reads the flat {owner}__{repo}.json file (#1390 back-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, "owner__repo.json"), '{"gate":{"enabled":true}}');
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/repo")).toBe('{"gate":{"enabled":true}}');
  });

  it("falls back to the dir-root global .gittensory.yml for a repo with no per-repo file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".gittensory.yml"), "gate:\n  enabled: false\n");
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/unconfigured")).toBe("gate:\n  enabled: false\n");
  });

  it("prefers a per-repo file over the global fallback when both exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".gittensory.yml"), "gate:\n  enabled: false\n"); // global
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", ".gittensory.yml"), "gate:\n  enabled: true\n"); // per-repo wins
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/repo")).toBe("gate:\n  enabled: true\n");
  });

  it("returns null when neither a per-repo file nor a global fallback exists (⇒ loader uses the public file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/unconfigured")).toBeNull();
  });

  it("does NOT serve the global fallback to an invalid repo full name (no per-repo candidates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dir, ".gittensory.yml"), "gate:\n  enabled: false\n"); // global present
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("no-slash")).toBeNull(); // perRepo.length === 0 early return
  });

  it("rejects traversal repo names instead of reading outside the private config directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-repo-config-"));
    writeFileSync(join(dirname(dir), ".gittensory.yml"), "gate:\n  enabled: true\n");
    const reader = makeLocalManifestReader(dir);
    expect(await reader!("owner/..")).toBeNull();
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
