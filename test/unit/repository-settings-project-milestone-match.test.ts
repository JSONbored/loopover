import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

// #3183/loopover#6445: autoProjectMilestoneMatch is the tri-state config for auto-project/milestone matching,
// mirroring the reviewCheckMode template (#2852). "off" is the conservative, opt-in default; "suggest" and
// "auto" currently behave identically (post a comment) since real milestone attachment isn't wired until
// #3185. Moved off the DB entirely (config-as-code migration, loopover#6445) -- config-as-code only via
// .loopover.yml's settings: block now.
describe("repository_settings: autoProjectMilestoneMatch config-as-code (#3183)", () => {
  it("getRepositorySettings returns off for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.autoProjectMilestoneMatch).toBe("off");
  });

  it("getRepositorySettings ignores a caller-supplied override on upsert -- always off (no DB column to persist it in)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", autoProjectMilestoneMatch: "suggest" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.autoProjectMilestoneMatch).toBe("off");
  });

  it("resolveRepositorySettings honors an explicit suggest/auto opt-in from .loopover.yml's settings: block", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip" });
    await upsertRepoFocusManifest(env, "acme/round-trip", { settings: { autoProjectMilestoneMatch: "suggest" } });
    const settings = await resolveRepositorySettings(env, "acme/round-trip");
    expect(settings.autoProjectMilestoneMatch).toBe("suggest");
  });

  it("auto resolves distinctly from suggest via the manifest overlay", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/auto-mode" });
    await upsertRepoFocusManifest(env, "acme/auto-mode", { settings: { autoProjectMilestoneMatch: "auto" } });
    const settings = await resolveRepositorySettings(env, "acme/auto-mode");
    expect(settings.autoProjectMilestoneMatch).toBe("auto");
  });
});

// #3186/loopover#6445: autoProjectMilestoneMatchBackend selects which tracker the match/attach logic queries --
// "github" (Milestones + Projects v2, the conservative default) or "linear" (an opted-in per-repo API key).
// Moved off the DB entirely (config-as-code migration, loopover#6445).
describe("repository_settings: autoProjectMilestoneMatchBackend config-as-code (#3186)", () => {
  it("getRepositorySettings returns github for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("github");
  });

  it("getRepositorySettings ignores a caller-supplied override on upsert -- always github (no DB column to persist it in)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/linear-backend", autoProjectMilestoneMatchBackend: "linear" });
    const settings = await getRepositorySettings(env, "acme/linear-backend");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("github");
  });

  it("resolveRepositorySettings honors an explicit linear opt-in from .loopover.yml's settings: block", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/linear-backend" });
    await upsertRepoFocusManifest(env, "acme/linear-backend", { settings: { autoProjectMilestoneMatchBackend: "linear" } });
    const settings = await resolveRepositorySettings(env, "acme/linear-backend");
    expect(settings.autoProjectMilestoneMatchBackend).toBe("linear");
  });
});
