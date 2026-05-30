import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";

const runLiveContracts = process.env.RUN_LIVE_UPSTREAM_CONTRACTS === "true";

describe.skipIf(!runLiveContracts)("live upstream Gittensor contract", () => {
  it("can fetch upstream sources and normalize a scoreable ruleset", async () => {
    const { refreshUpstreamDrift } = await import("../../src/upstream/ruleset");
    const env = createTestEnv(process.env.GITHUB_TOKEN ? { GITHUB_PUBLIC_TOKEN: process.env.GITHUB_TOKEN } : {});

    const result = await refreshUpstreamDrift(env);

    expect(result.sources).toHaveLength(6);
    expect(result.sources.filter((source) => source.status === "error")).toEqual([]);
    expect(result.ruleset.registryRepoCount).toBeGreaterThan(0);
    expect(result.ruleset.activeModel).not.toBe("unknown");
    expect(result.ruleset.payload).toMatchObject({
      registry: expect.objectContaining({
        repositories: expect.arrayContaining([expect.objectContaining({ repo: "JSONbored/gittensory" })]),
      }),
      scoring: expect.objectContaining({ activeModel: result.ruleset.activeModel }),
      issueDiscovery: expect.objectContaining({ branchEligibilityRequired: expect.any(Boolean) }),
      mirrorLinkage: expect.objectContaining({ solvedByPrRequired: expect.any(Boolean) }),
    });
  });
});
