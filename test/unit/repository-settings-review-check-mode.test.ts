import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2852: reviewCheckMode is the new, more expressive axis for the "Gittensory Orb Review Agent" check-run
// publish decision (required/visible/disabled), replacing gateCheckMode (off/enabled) as the runtime authority
// while gateCheckMode itself stays wired for API/back-compat display. These tests pin the default + the
// same-call legacy-write derivation that lets a caller who only ever sets gateCheckMode keep its historical
// effect without touching reviewCheckMode at all.
describe("repository_settings: reviewCheckMode default + legacy gateCheckMode derivation (#2852)", () => {
  it("getRepositorySettings returns disabled for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.reviewCheckMode).toBe("disabled");
    expect(settings.gateCheckMode).toBe("off");
  });

  it("upsertRepositorySettings persists disabled when the caller omits reviewCheckMode AND gateCheckMode entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-both" });
    const settings = await getRepositorySettings(env, "acme/omits-both");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("a caller that sets ONLY gateCheckMode: enabled (never touching reviewCheckMode) still gets the check published (legacy-write compatibility)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/legacy-enable", gateCheckMode: "enabled" });
    const settings = await getRepositorySettings(env, "acme/legacy-enable");
    expect(settings.reviewCheckMode).toBe("required");
    expect(settings.gateCheckMode).toBe("enabled");
  });

  it("a caller that sets ONLY gateCheckMode: off (never touching reviewCheckMode) stays disabled", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/legacy-disable", gateCheckMode: "off" });
    const settings = await getRepositorySettings(env, "acme/legacy-disable");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("an explicit reviewCheckMode wins over gateCheckMode when both are set in the same call", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/explicit-wins", gateCheckMode: "off", reviewCheckMode: "visible" });
    const settings = await getRepositorySettings(env, "acme/explicit-wins");
    expect(settings.reviewCheckMode).toBe("visible");
  });

  it("an explicit required/visible/disabled opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", reviewCheckMode: "visible" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.reviewCheckMode).toBe("visible");
    // A true read-modify-write caller (the route-handler pattern: spread current settings, then override) must
    // carry the persisted value forward explicitly -- upsertRepositorySettings never merges against the DB row.
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.reviewCheckMode).toBe("visible");
  });

  it("an invalid persisted DB value fails closed to disabled on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET review_check_mode = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.reviewCheckMode).toBe("disabled");
  });
});
