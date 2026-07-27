import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { repositories } from "../../src/db/schema";
import { upsertRepositorySettings } from "../../src/db/repositories";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

// #9033: copycatGateMode has no DB column (config-as-code only) -- registration status ("reward-eligible", i.e.
// this repo's merged PRs actually earn Gittensor rewards) is a `repositories.is_registered` column instead, so
// these tests seed that row directly via drizzle (mirrors upsertRepositoryFromGitHub's own insert shape) rather
// than through a settings helper that has no field for it.
async function seedRepo(env: Env, fullName: string, isRegistered: boolean): Promise<void> {
  const [owner, name] = fullName.split("/") as [string, string];
  await getDb(env.DB)
    .insert(repositories)
    .values({ fullName, owner, name, isRegistered });
}

describe("resolveRepositorySettings: copycatGateMode reward-eligible default (#9033)", () => {
  it("resolves to warn for a REGISTERED repo that never configured gate.copycat.mode", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/registered-no-config", true);
    await upsertRepositorySettings(env, { repoFullName: "acme/registered-no-config" });
    const settings = await resolveRepositorySettings(env, "acme/registered-no-config");
    expect(settings.copycatGateMode).toBe("warn");
  });

  it("keeps off for an UNREGISTERED repo that never configured gate.copycat.mode (byte-identical to before #9033)", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/unregistered-no-config", false);
    await upsertRepositorySettings(env, { repoFullName: "acme/unregistered-no-config" });
    const settings = await resolveRepositorySettings(env, "acme/unregistered-no-config");
    expect(settings.copycatGateMode).toBe("off");
  });

  it("keeps off for a repo LoopOver has never seen at all (getRepository resolves null, treated as unregistered)", async () => {
    const env = createTestEnv();
    const settings = await resolveRepositorySettings(env, "acme/never-seen");
    expect(settings.copycatGateMode).toBe("off");
  });

  it("an explicit gate.copycat.mode: off in .loopover.yml is NEVER overridden, even on a registered repo", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/registered-explicit-off", true);
    await upsertRepositorySettings(env, { repoFullName: "acme/registered-explicit-off" });
    await upsertRepoFocusManifest(env, "acme/registered-explicit-off", { gate: { copycat: { mode: "off" } } });
    const settings = await resolveRepositorySettings(env, "acme/registered-explicit-off");
    expect(settings.copycatGateMode).toBe("off");
  });

  it("an explicit gate.copycat.mode: block in .loopover.yml is honored on an UNREGISTERED repo (config-as-code always wins)", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/unregistered-explicit-block", false);
    await upsertRepositorySettings(env, { repoFullName: "acme/unregistered-explicit-block" });
    await upsertRepoFocusManifest(env, "acme/unregistered-explicit-block", { gate: { copycat: { mode: "block" } } });
    const settings = await resolveRepositorySettings(env, "acme/unregistered-explicit-block");
    expect(settings.copycatGateMode).toBe("block");
  });
});
