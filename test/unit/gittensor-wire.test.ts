import { describe, expect, it } from "vitest";
import { gittensorEnabledRepoFullNames, isGittensorPluginEnabled, shouldEnableGittensorForRepo } from "../../src/review/gittensor-wire";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 0)")
    .bind(fullName, owner, name)
    .run();
}

// Wrap env.DB.prepare so any SQL matching `pattern` throws, exercising a fail-safe catch; every other query
// delegates to the real test DB unchanged. Mirrors selftune-wiring.test.ts's poisonDbPrepare.
function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

describe("isGittensorPluginEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isGittensorPluginEnabled({})).toBe(false);
    expect(isGittensorPluginEnabled({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "false" })).toBe(false);
    expect(isGittensorPluginEnabled({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" })).toBe(true);
    expect(isGittensorPluginEnabled({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "1" })).toBe(true);
    expect(isGittensorPluginEnabled({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "on" })).toBe(true);
    expect(isGittensorPluginEnabled({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "yes" })).toBe(true);
  });
});

describe("shouldEnableGittensorForRepo", () => {
  it("requires BOTH the operator env flag AND the per-repo manifest opt-in", () => {
    expect(shouldEnableGittensorForRepo({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" }, true)).toBe(true);
  });

  it("is OFF when the operator flag is on but the manifest didn't opt in", () => {
    expect(shouldEnableGittensorForRepo({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" }, false)).toBe(false);
    expect(shouldEnableGittensorForRepo({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" }, null)).toBe(false);
    expect(shouldEnableGittensorForRepo({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" }, undefined)).toBe(false);
  });

  it("is OFF when the manifest opted in but the operator flag is off (repo cannot self-enable)", () => {
    expect(shouldEnableGittensorForRepo({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "false" }, true)).toBe(false);
    expect(shouldEnableGittensorForRepo({}, true)).toBe(false);
  });

  it("is OFF when both are off", () => {
    expect(shouldEnableGittensorForRepo({}, false)).toBe(false);
  });
});

describe("gittensorEnabledRepoFullNames", () => {
  it("short-circuits to an empty set when the operator flag is off, without reading the repositories table", () => {
    const env = createTestEnv();
    // If this ever queried the DB despite the flag being off, the poisoned "repositories" query would throw
    // and this test would fail with an unhandled rejection instead of resolving cleanly.
    poisonDbPrepare(env, /"repositories"/i);
    return expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set());
  });

  it("is empty when the flag is on but no repos are locally known", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set());
  });

  it("excludes a repo whose manifest never sets experimental.gittensor", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await seedRegisteredRepo(env, "owner/unopted");
    await upsertRepoFocusManifest(env, "owner/unopted", { wantedPaths: ["src/"] });
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set());
  });

  it("excludes a repo that explicitly sets experimental.gittensor: false", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await seedRegisteredRepo(env, "owner/optedout");
    await upsertRepoFocusManifest(env, "owner/optedout", { experimental: { gittensor: false } });
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set());
  });

  it("includes only the repos that explicitly opt in, lowercased, out of a mixed set", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await seedRegisteredRepo(env, "Owner/OptedIn");
    await upsertRepoFocusManifest(env, "Owner/OptedIn", { experimental: { gittensor: true } });
    await seedRegisteredRepo(env, "owner/other");
    await upsertRepoFocusManifest(env, "owner/other", { experimental: { gittensor: false } });
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set(["owner/optedin"]));
  });

  it("is not gated by isRegistered — a not-yet-registered but opted-in repo is still included (avoids the chicken-and-egg deadlock)", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await seedRegisteredRepo(env, "owner/notyetregistered"); // seeded with is_registered=0
    await upsertRepoFocusManifest(env, "owner/notyetregistered", { experimental: { gittensor: true } });
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set(["owner/notyetregistered"]));
  });

  it("fails safe per-repo: a manifest-load error is swallowed and the pass still resolves", async () => {
    const env = createTestEnv({ GITTENSORY_EXPERIMENTAL_GITTENSOR: "true" });
    await seedRegisteredRepo(env, "owner/blip");
    // loadRepoFocusManifest's cache read hits signal_snapshots; poison it so the per-repo try/catch fires.
    poisonDbPrepare(env, /"signal_snapshots"/i);
    await expect(gittensorEnabledRepoFullNames(env)).resolves.toEqual(new Set());
  });
});
