import { describe, expect, it, vi } from "vitest";
import { extractRepoProfile, REPO_PROFILE_SCHEMA_VERSION } from "../../src/review/repo-profile";
import * as ragIndexModule from "../../src/review/rag-index";
import { upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";
const [PROJECT, CHUNK_REPO] = ["owner", "widgets"];

async function seedChunk(env: ReturnType<typeof createTestEnv>, path: string, text: string, chunkIndex = 0): Promise<void> {
  await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
    .bind(`${path}::${chunkIndex}`, PROJECT, CHUNK_REPO, path, chunkIndex, "code", text)
    .run();
}

describe("extractRepoProfile (#2999)", () => {
  it("returns the explicit insufficient-data branch when the repo has no RAG index at all", async () => {
    const env = createTestEnv({});
    const profile = await extractRepoProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(profile).toEqual({
      version: REPO_PROFILE_SCHEMA_VERSION,
      present: false,
      repoFullName: REPO,
      generatedAt: "2026-07-05T00:00:00.000Z",
      reason: "no RAG index configured or populated for this repo yet",
    });
  });

  it("extracts a full profile from seeded chunks, settings, and manifest", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget-factory.ts", "export function makeWidget() {}");
    await seedChunk(env, "src/widget-helpers.ts", "export function helpWidget() {}");
    await seedChunk(env, "src/gadget-tool.ts", "export function makeGadget() {}");
    await seedChunk(env, "test/unit/widget-factory.test.ts", "it('works', () => {})");
    await seedChunk(env, ".github/workflows/ci.yml", "name: CI\non: push\n");
    await seedChunk(
      env,
      "package.json",
      JSON.stringify({
        packageManager: "npm@10.2.0",
        scripts: { test: "vitest run", "test:coverage": "vitest run --coverage", lint: "eslint .", build: "tsc" },
      }),
    );
    await upsertRepositorySettings(env, { repoFullName: REPO, reviewCheckMode: "required", requireLinkedIssue: true });
    await upsertRepoFocusManifest(env, REPO, { linkedIssuePolicy: "required" });

    const profile = await extractRepoProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });

    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.version).toBe(REPO_PROFILE_SCHEMA_VERSION);
    expect(profile.repoFullName).toBe(REPO);
    expect(profile.generatedAt).toBe("2026-07-05T00:00:00.000Z");
    expect(profile.architecture).toEqual({
      indexedFileCount: 6,
      topLevelDirectories: [
        { path: "src", fileCount: 3 },
        // "." is the root-file sentinel (package.json has no directory component).
        { path: ".", fileCount: 1 },
        { path: ".github", fileCount: 1 },
        { path: "test", fileCount: 1 },
      ],
    });
    expect(profile.conventions).toEqual({ fileNamingStyle: "kebab-case", testFileConvention: "dot-test-suffix" });
    expect(profile.commands).toEqual({
      packageManager: "npm",
      buildCommands: ["build"],
      testCommands: ["test", "test:coverage"],
      lintCommands: ["lint"],
    });
    expect(profile.contributionWorkflow).toEqual({
      gatePublishesCheck: true,
      linkedIssuePolicy: "required",
      requireLinkedIssue: true,
      linkedIssueGateMode: "advisory",
      ciWorkflowFiles: [".github/workflows/ci.yml"],
    });
  });

  it("treats a top-level file (no directory) under the '.' sentinel", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "README.md", "# widgets");
    await seedChunk(env, "src/index.ts", "export {}");
    const profile = await extractRepoProfile(env, REPO);
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.architecture.topLevelDirectories).toContainEqual({ path: ".", fileCount: 1 });
  });

  it("reports snake_case when that style has a clear majority", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget_factory.ts", "x");
    await seedChunk(env, "src/widget_helper.ts", "x");
    await seedChunk(env, "src/gadget_tool.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.fileNamingStyle).toBe("snake_case");
  });

  it("reports camelCase when that style has a clear majority", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widgetFactory.ts", "x");
    await seedChunk(env, "src/widgetHelper.ts", "x");
    await seedChunk(env, "src/gadgetTool.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.fileNamingStyle).toBe("camelCase");
  });

  it("reports PascalCase when that style has a clear majority", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/WidgetFactory.ts", "x");
    await seedChunk(env, "src/WidgetHelper.ts", "x");
    await seedChunk(env, "src/GadgetTool.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.fileNamingStyle).toBe("PascalCase");
  });

  it("reports mixed when no single naming style has a clear majority", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget-factory.ts", "x");
    await seedChunk(env, "src/widgetHelper.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.fileNamingStyle).toBe("mixed");
  });

  it("reports unknown naming style when no indexed basename carries a casing signal", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/index.ts", "x");
    await seedChunk(env, "src/types.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.fileNamingStyle).toBe("unknown");
  });

  it("detects the dot-spec-suffix test convention", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "src/widget.spec.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.testFileConvention).toBe("dot-spec-suffix");
  });

  it("detects the tests-directory convention", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "__tests__/widget.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.testFileConvention).toBe("tests-directory");
  });

  it("reports none-detected when no indexed path matches any test convention", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.conventions.testFileConvention).toBe("none-detected");
  });

  it("degrades to empty commands when package.json is not indexed", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
  });

  it("degrades to empty commands when package.json is malformed JSON", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", "{ not json");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
  });

  it("degrades to empty commands when package.json parses to a JSON primitive, not an object (arrays are typeof 'object' in JS, so this needs a genuine primitive to exercise the guard)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", "42");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
  });

  it("degrades to empty commands when package.json parses to a bare JSON array (typeof 'object' but not a record)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", "[1, 2, 3]");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
  });

  it("leaves packageManager null when the field is absent or doesn't match a known manager", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: {} }));
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands.packageManager).toBeNull();
  });

  it("reassembles a multi-chunk package.json in chunk_index order", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const scripts = JSON.stringify({ scripts: { test: "vitest run" } });
    await seedChunk(env, "package.json", scripts.slice(0, 10), 0);
    await seedChunk(env, "package.json", scripts.slice(10), 1);
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands.testCommands).toEqual(["test"]);
  });

  it("categorizes a script matching multiple keywords under its first-matching category only (test before lint before build)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { "test:lint:build": "echo x" } }));
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toMatchObject({ testCommands: ["test:lint:build"], lintCommands: [], buildCommands: [] });
  });

  it("skips a non-string script value without throwing", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { test: 42 } }));
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands.testCommands).toEqual([]);
  });

  it("treats an array-valued scripts field as malformed rather than walking its indices", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: ["test", "build"] }));
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
  });

  it("reflects gatePublishesCheck true when reviewCheckMode is required, regardless of legacy checkRunMode", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await upsertRepositorySettings(env, {
      repoFullName: REPO,
      checkRunMode: "off",
      reviewCheckMode: "required",
    });
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.gatePublishesCheck).toBe(true);
  });

  it("reflects gatePublishesCheck false when reviewCheckMode is disabled (#3039 regression)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    // Legacy checkRunMode says "enabled", but reviewCheckMode -- the actual runtime authority for check
    // publication (#2852) -- says "disabled". gatePublishesCheck must follow reviewCheckMode, not the
    // legacy back-compat-only field, or a repo that disabled the check via .gittensory.yml's
    // gate.checkMode still gets reported as publishing one.
    await upsertRepositorySettings(env, {
      repoFullName: REPO,
      checkRunMode: "enabled",
      reviewCheckMode: "disabled",
    });
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.gatePublishesCheck).toBe(false);
  });

  it("reflects gatePublishesCheck true when reviewCheckMode is visible", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await upsertRepositorySettings(env, { repoFullName: REPO, reviewCheckMode: "visible" });
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.gatePublishesCheck).toBe(true);
  });

  it("defaults linkedIssuePolicy to optional when the repo has no manifest", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.linkedIssuePolicy).toBe("optional");
  });

  it("reports no CI workflow files when none are indexed", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.ciWorkflowFiles).toEqual([]);
  });

  it("does not match a non-workflow file that merely lives under .github/", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, ".github/CODEOWNERS", "* @owner");
    const profile = await extractRepoProfile(env, REPO);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.contributionWorkflow.ciWorkflowFiles).toEqual([]);
  });

  it("REGRESSION: treats a non-empty chunk count with a failed path listing as insufficient data, not a zero-file profile", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    const listSpy = vi.spyOn(ragIndexModule, "listStoredChunkPaths").mockResolvedValueOnce([]);
    try {
      const profile = await extractRepoProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
      expect(profile).toEqual({
        version: REPO_PROFILE_SCHEMA_VERSION,
        present: false,
        repoFullName: REPO,
        generatedAt: "2026-07-05T00:00:00.000Z",
        reason: "repo chunk store is unavailable (path listing failed)",
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it("treats a bare repo name with no owner segment as an empty project", async () => {
    const env = createTestEnv({});
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind("src/widget.ts::0", "", "bare-repo-name", "src/widget.ts", 0, "code", "x")
      .run();
    const profile = await extractRepoProfile(env, "bare-repo-name");
    expect(profile.present).toBe(true);
  });

  it("degrades to null when the path-listing query's own result row set is undefined (D1's results field is optional)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("SELECT chunk_index, text FROM repo_chunks")) {
        return { bind: () => ({ all: async () => ({}) }) } as unknown as ReturnType<typeof env.DB.prepare>;
      }
      return originalPrepare(query);
    });
    try {
      const profile = await extractRepoProfile(env, REPO);
      if (!profile.present) throw new Error("expected present profile");
      // The package.json read degraded to null (no results), so commands stay empty rather than throwing.
      expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("degrades to empty commands when the package.json read itself throws (storage error)", async () => {
    const env = createTestEnv({});
    await seedChunk(env, "src/widget.ts", "x");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("SELECT chunk_index, text FROM repo_chunks")) throw new Error("storage unavailable");
      return originalPrepare(query);
    });
    try {
      const profile = await extractRepoProfile(env, REPO);
      if (!profile.present) throw new Error("expected present profile");
      expect(profile.commands).toEqual({ packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] });
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
