import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #3183: autoProjectMilestoneMatch is the tri-state config for auto-project/milestone matching, mirroring the
// reviewCheckMode template (#2852). "off" is the conservative, opt-in default; "suggest" and "auto" currently
// behave identically (post a comment) since real milestone attachment isn't wired until #3185.
describe("repository_settings: autoProjectMilestoneMatch default + round-trip (#3183)", () => {
  it("getRepositorySettings returns off for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.autoProjectMilestoneMatch).toBe("off");
  });

  it("upsertRepositorySettings persists off when the caller omits the field entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-field" });
    const settings = await getRepositorySettings(env, "acme/omits-field");
    expect(settings.autoProjectMilestoneMatch).toBe("off");
  });

  it("an explicit suggest/auto opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", autoProjectMilestoneMatch: "suggest" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.autoProjectMilestoneMatch).toBe("suggest");
    // A true read-modify-write caller (the route-handler pattern: spread current settings, then override) must
    // carry the persisted value forward explicitly -- upsertRepositorySettings never merges against the DB row.
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.autoProjectMilestoneMatch).toBe("suggest");
  });

  it("auto round-trips distinctly from suggest", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/auto-mode", autoProjectMilestoneMatch: "auto" });
    const settings = await getRepositorySettings(env, "acme/auto-mode");
    expect(settings.autoProjectMilestoneMatch).toBe("auto");
  });

  it("an invalid persisted DB value fails closed to off on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET project_milestone_match_mode = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.autoProjectMilestoneMatch).toBe("off");
  });
});

// #3186: autoProjectMilestoneMatchBackend selects which tracker the match/attach logic queries -- "github"
// (Milestones + Projects v2, the conservative default) or "linear" (an opted-in per-repo API key).
describe("repository_settings: autoProjectMilestoneMatchBackend default + round-trip (#3186)", () => {
  it("getRepositorySettings returns github for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("github");
  });

  it("an explicit linear opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/linear-backend", autoProjectMilestoneMatchBackend: "linear" });
    const settings = await getRepositorySettings(env, "acme/linear-backend");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("linear");
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/linear-backend" });
    const after = await getRepositorySettings(env, "acme/linear-backend");
    expect(after.autoProjectMilestoneMatchBackend).toBe("linear");
  });

  it("an invalid persisted DB value fails closed to github on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed-backend" });
    await env.DB.prepare("UPDATE repository_settings SET auto_project_milestone_match_backend = ? WHERE repo_full_name = ?").bind("jira", "acme/malformed-backend").run();
    const settings = await getRepositorySettings(env, "acme/malformed-backend");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("github");
  });
});
