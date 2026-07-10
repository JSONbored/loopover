import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2006: the config-driven before/after screenshot-table gate is off by default (zero behavior change for an
// install that hasn't opted in) and layers whenLabels/whenPaths/action/message through the same DB round-trip
// every other anti-abuse mechanism uses (contributor blacklist / review-nag / review-evasion).
describe("repository_settings: screenshotTableGate (#2006)", () => {
  it("getRepositorySettings returns the disabled default for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.screenshotTableGate).toEqual({ enabled: false, whenLabels: [], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] });
  });

  it("upsertRepositorySettings persists the disabled default when the caller omits screenshotTableGate entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-it" });
    const settings = await getRepositorySettings(env, "acme/omits-it");
    expect(settings.screenshotTableGate?.enabled).toBe(false);
  });

  it("round-trips a fully configured gate (enabled, scoped, custom action + message)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "acme/configured",
      screenshotTableGate: {
        enabled: true,
        whenLabels: ["frontend", "visual"],
        whenPaths: ["apps/ui/**"],
        action: "close",
        requireViewports: [],
        requireThemes: [],
        message: "Custom contract text",
      },
    });
    const settings = await getRepositorySettings(env, "acme/configured");
    expect(settings.screenshotTableGate).toEqual({
      enabled: true,
      whenLabels: ["frontend", "visual"],
      whenPaths: ["apps/ui/**"],
      action: "close",
      requireViewports: [],
      requireThemes: [],
      message: "Custom contract text",
    });
  });

  it("round-trips skillFileUrl alongside a custom message (#4540 follow-up)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "acme/skill-link",
      screenshotTableGate: {
        enabled: true,
        whenLabels: [],
        whenPaths: [],
        action: "close",
        requireViewports: [],
        requireThemes: [],
        skillFileUrl: "https://github.com/acme/widget/blob/main/SKILL.md",
      },
    });
    const settings = await getRepositorySettings(env, "acme/skill-link");
    expect(settings.screenshotTableGate?.skillFileUrl).toBe("https://github.com/acme/widget/blob/main/SKILL.md");
  });

  it("omits `skillFileUrl` entirely when unset (never persists an empty string) (#4540 follow-up)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/no-skill-link", screenshotTableGate: { enabled: true, whenLabels: [], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] } });
    const settings = await getRepositorySettings(env, "acme/no-skill-link");
    expect(settings.screenshotTableGate?.skillFileUrl).toBeUndefined();
  });

  it("a true read-modify-write caller carries the persisted value forward explicitly (no DB merge)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", screenshotTableGate: { enabled: true, whenLabels: ["visual"], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] } });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.screenshotTableGate).toEqual({ enabled: true, whenLabels: ["visual"], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] });
  });

  it("omits `message` entirely when unset (never persists an empty string)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/no-message", screenshotTableGate: { enabled: true, whenLabels: [], whenPaths: [], action: "close", requireViewports: [], requireThemes: [] } });
    const settings = await getRepositorySettings(env, "acme/no-message");
    expect(settings.screenshotTableGate?.message).toBeUndefined();
  });

  it("an invalid persisted action column fails closed to the default (close) on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET screenshot_table_gate_action = ? WHERE repo_full_name = ?").bind("nonsense", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.screenshotTableGate?.action).toBe("close");
  });

  it("a malformed JSON whenLabels/whenPaths column fails closed to an empty list on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/bad-json" });
    await env.DB.prepare("UPDATE repository_settings SET screenshot_table_gate_when_labels_json = ?, screenshot_table_gate_when_paths_json = ? WHERE repo_full_name = ?")
      .bind("not json", "not json", "acme/bad-json")
      .run();
    const settings = await getRepositorySettings(env, "acme/bad-json");
    expect(settings.screenshotTableGate?.whenLabels).toEqual([]);
    expect(settings.screenshotTableGate?.whenPaths).toEqual([]);
  });

  it("REGRESSION: valid JSON that parses to a non-array (an object) also fails closed to an empty list, not just a JSON syntax error", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/non-array-json" });
    await env.DB.prepare("UPDATE repository_settings SET screenshot_table_gate_when_labels_json = ?, screenshot_table_gate_when_paths_json = ? WHERE repo_full_name = ?")
      .bind('{"frontend":true}', "42", "acme/non-array-json")
      .run();
    const settings = await getRepositorySettings(env, "acme/non-array-json");
    expect(settings.screenshotTableGate?.whenLabels).toEqual([]);
    expect(settings.screenshotTableGate?.whenPaths).toEqual([]);
  });
});
