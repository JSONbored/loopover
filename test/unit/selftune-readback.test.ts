import { describe, expect, it } from "vitest";
import { upsertRepositorySettings } from "../../src/db/repositories";
import { writeLiveOverride, type StorageEnv } from "../../src/review/auto-apply";
import { applySelfTuneOverrideToSettings, resolveRepositorySettings } from "../../src/settings/repository-settings";
import type { RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// The promoted override is ALWAYS a tightening (selftune-wire only ever populates the would-merge error side),
// so the read-back must only ever RAISE an existing readiness threshold — never create or lower one.
const baseSettings = { qualityGateMinScore: 50 } as RepositorySettings;

describe("applySelfTuneOverrideToSettings — tightening-only live read-back (#self-improve)", () => {
  it("RAISES an existing readiness threshold to the promoted floor (confidenceFloor 0.7 → 70)", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.7 }).qualityGateMinScore).toBe(70);
  });

  it("NEVER lowers — a floor at or below the current threshold is a no-op (same object back)", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.5 })).toBe(baseSettings); // 50 ≯ 50
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.3 })).toBe(baseSettings); // 30 < 50
  });

  it("NEVER creates a gate the operator didn't set (null threshold ⇒ unchanged)", () => {
    const noGate = { qualityGateMinScore: null } as RepositorySettings;
    expect(applySelfTuneOverrideToSettings(noGate, { confidenceFloor: 0.9 })).toBe(noGate);
  });

  it("no override / no promoted floor ⇒ unchanged", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, null)).toBe(baseSettings);
    expect(applySelfTuneOverrideToSettings(baseSettings, {})).toBe(baseSettings);
  });
});

describe("resolveRepositorySettings — self-tune override overlay (flag-gated)", () => {
  const repo = "acme/widgets";
  async function seed(env: Env): Promise<void> {
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'widgets', 1, 1)").bind(repo).run();
    await upsertRepositorySettings(env, { repoFullName: repo, qualityGateMinScore: 50 });
    await writeLiveOverride(env as unknown as StorageEnv, repo, { confidenceFloor: 0.7 });
  }

  it("flag ON: overlays the promoted tightening override (50 → 70)", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_SELFTUNE: "true" });
    await seed(env);
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(70);
  });

  it("flag OFF (default): the override is never read — settings stay byte-identical (50)", async () => {
    const env = createTestEnv();
    await seed(env);
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(50);
  });
});
