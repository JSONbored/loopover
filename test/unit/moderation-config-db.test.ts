import { describe, expect, it } from "vitest";
import {
  countModerationViolationsForActor,
  getGlobalModerationConfig,
  getRepositorySettings,
  recordModerationViolation,
  upsertGlobalModerationConfig,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";
import { DEFAULT_GLOBAL_MODERATION_CONFIG, MODERATION_VIOLATION_EVENT_TYPE } from "../../src/settings/moderation-rules";

describe("global moderation config DB round-trip (#selfhost-mod-engine)", () => {
  it("defaults to DEFAULT_GLOBAL_MODERATION_CONFIG (off) for a fresh install", async () => {
    const env = createTestEnv();
    expect(await getGlobalModerationConfig(env)).toEqual(DEFAULT_GLOBAL_MODERATION_CONFIG);
  });

  it("returns the default when the singleton row is missing", async () => {
    const env = createTestEnv();
    await env.DB.prepare("DELETE FROM global_moderation_config WHERE id = 'singleton'").run();
    expect(await getGlobalModerationConfig(env)).toEqual(DEFAULT_GLOBAL_MODERATION_CONFIG);
  });

  it("fails open to the default when the table is unavailable", async () => {
    const env = createTestEnv();
    await env.DB.prepare("DROP TABLE global_moderation_config").run();
    expect(await getGlobalModerationConfig(env)).toEqual(DEFAULT_GLOBAL_MODERATION_CONFIG);
  });

  it("falls back to the default warning/banned label when the stored row has an empty/whitespace label (e.g. written directly via raw SQL, bypassing app-level upsert validation)", async () => {
    const env = createTestEnv();
    await env.DB.prepare("UPDATE global_moderation_config SET warning_label = '', banned_label = '   ' WHERE id = 'singleton'").run();
    const resolved = await getGlobalModerationConfig(env);
    expect(resolved.warningLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.warningLabel);
    expect(resolved.bannedLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.bannedLabel);
  });

  it("persists a full upsert and reads it back", async () => {
    const env = createTestEnv();
    const resolved = await upsertGlobalModerationConfig(env, {
      enabled: true,
      rules: ["blacklist", "review_nag"],
      warningLabel: "custom:warning",
      bannedLabel: "custom:banned",
      banThreshold: 3,
      violationDecayDays: 90,
      autoBlacklistOnBan: false,
      updatedBy: "JSONbored",
    });
    expect(resolved).toEqual({
      enabled: true,
      rules: ["blacklist", "review_nag"],
      warningLabel: "custom:warning",
      bannedLabel: "custom:banned",
      banThreshold: 3,
      violationDecayDays: 90,
      autoBlacklistOnBan: false,
    });
    expect(await getGlobalModerationConfig(env)).toEqual(resolved);
  });

  it("a PARTIAL upsert only changes the given fields, preserving the rest from the current row", async () => {
    const env = createTestEnv();
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 3 });
    const resolved = await upsertGlobalModerationConfig(env, { warningLabel: "mod:caution" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.banThreshold).toBe(3);
    expect(resolved.warningLabel).toBe("mod:caution");
  });

  it("drops an invalid rule type on upsert with a fallback to a valid subset, and coerces a malformed threshold/label back to the current value", async () => {
    const env = createTestEnv();
    const invalidRules = ["blacklist", "not-a-rule"] as unknown as ("contributor_cap" | "blacklist" | "review_nag")[];
    const resolved = await upsertGlobalModerationConfig(env, { rules: invalidRules, banThreshold: -1, warningLabel: "   " });
    expect(resolved.rules).toEqual(["blacklist"]);
    // Malformed values fall back to the CURRENT row's value (this is the first write, so that's still the
    // module default), not silently to 0/empty.
    expect(resolved.banThreshold).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.banThreshold);
    expect(resolved.warningLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.warningLabel);
  });
});

describe("moderation violation ledger (#selfhost-mod-engine)", () => {
  it("records a violation and counts it back for the actor", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, {
      eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap,
      actor: "farmer99",
      targetKey: "owner/repo#42",
      repoFullName: "owner/repo",
      ruleReason: "contributor_cap violation",
    });
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.contributor_cap]);
    expect(count).toBe(1);
  });

  it("counts across MULTIPLE rule types and MULTIPLE repos for the same actor (install-wide, not per-repo)", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo-a#1", repoFullName: "owner/repo-a", ruleReason: "cap" });
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo-b#2", repoFullName: "owner/repo-b", ruleReason: "blacklist" });
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.review_nag, actor: "someone-else", targetKey: "owner/repo-a#3", repoFullName: "owner/repo-a", ruleReason: "nag" });
    const count = await countModerationViolationsForActor(env, "farmer99", Object.values(MODERATION_VIOLATION_EVENT_TYPE));
    expect(count).toBe(2); // only farmer99's two, not someone-else's
  });

  it("respects an optional sinceIso rolling-window bound (violation-decay support)", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "old" });
    const futureIso = new Date(Date.now() + 60_000).toISOString(); // strictly after the just-recorded violation
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.blacklist], futureIso);
    expect(count).toBe(0); // outside the (future-dated, deliberately empty) window
  });

  it("returns 0 for an actor with no recorded violations", async () => {
    const env = createTestEnv();
    const count = await countModerationViolationsForActor(env, "nobody", Object.values(MODERATION_VIOLATION_EVENT_TYPE));
    expect(count).toBe(0);
  });
});

describe("per-repo moderation settings DB round-trip (#selfhost-mod-engine)", () => {
  it("defaults to 'inherit' gate mode and undefined overrides for an unconfigured repo", async () => {
    const settings = await getRepositorySettings(createTestEnv(), "owner/none");
    expect(settings.moderationGateMode).toBe("inherit");
    expect(settings.moderationRules).toBeUndefined();
    expect(settings.moderationWarningLabel).toBeUndefined();
    expect(settings.moderationBannedLabel).toBeUndefined();
  });

  it("persists an explicit gate mode + rule override + custom labels", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "owner/repo",
      moderationGateMode: "enabled",
      moderationRules: ["blacklist"],
      moderationWarningLabel: "repo:warn",
      moderationBannedLabel: "repo:ban",
    });
    const settings = await getRepositorySettings(env, "owner/repo");
    expect(settings.moderationGateMode).toBe("enabled");
    expect(settings.moderationRules).toEqual(["blacklist"]);
    expect(settings.moderationWarningLabel).toBe("repo:warn");
    expect(settings.moderationBannedLabel).toBe("repo:ban");
  });

  it("persists an explicit EMPTY moderationRules override distinctly from 'not configured' (undefined)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", moderationRules: [] });
    const settings = await getRepositorySettings(env, "owner/repo");
    expect(settings.moderationRules).toEqual([]);
  });

  it("round-trips through an UPDATE (not just the initial INSERT)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", moderationGateMode: "off" });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", moderationGateMode: "enabled", moderationWarningLabel: "updated:warn" });
    const settings = await getRepositorySettings(env, "owner/repo");
    expect(settings.moderationGateMode).toBe("enabled");
    expect(settings.moderationWarningLabel).toBe("updated:warn");
  });
});
