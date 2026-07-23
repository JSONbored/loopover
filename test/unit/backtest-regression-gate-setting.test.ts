import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// backtestRegressionGateMode persistence wiring (#8105): defaults, round-trip, and the unrecognized-value
// fallback. The behavioral (blocker/enforcement) sides live in gate-check-policy.test.ts and
// threshold-backtest-advisory-wiring.test.ts — this file pins ONLY the storage layer's three paths.

async function seedRepo(env: Env, fullName: string) {
  await upsertRepositoryFromGitHub(env, {
    id: 1,
    full_name: fullName,
    name: fullName.split("/")[1]!,
    owner: { login: fullName.split("/")[0]! },
    private: false,
    default_branch: "main",
  } as never);
}

describe("backtestRegressionGateMode setting (#8105)", () => {
  it("defaults to advisory — the shipped pre-#8105 behavior — for an unconfigured repo", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/unconfigured");
    expect(settings.backtestRegressionGateMode).toBe("advisory");
  });

  it("round-trips an explicit block, and an upsert omitting the field keeps the advisory default", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/widgets");
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", backtestRegressionGateMode: "block" });
    expect((await getRepositorySettings(env, "acme/widgets")).backtestRegressionGateMode).toBe("block");

    await seedRepo(env, "acme/other");
    await upsertRepositorySettings(env, { repoFullName: "acme/other" });
    expect((await getRepositorySettings(env, "acme/other")).backtestRegressionGateMode).toBe("advisory");
  });

  it("degrades an unrecognized stored value to advisory (parseGateRuleMode's fallback), never silently to block", async () => {
    const env = createTestEnv();
    await seedRepo(env, "acme/widgets");
    await upsertRepositorySettings(env, { repoFullName: "acme/widgets", backtestRegressionGateMode: "advisory" });
    await env.DB.prepare("UPDATE repository_settings SET backtest_regression_gate_mode = 'bogus' WHERE repo_full_name = ?")
      .bind("acme/widgets")
      .run();
    expect((await getRepositorySettings(env, "acme/widgets")).backtestRegressionGateMode).toBe("advisory");
  });
});
