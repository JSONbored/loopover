import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAttemptDbForkConfig } from "../../packages/loopover-miner/lib/attempt-db-fork-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAttemptDbForkConfig (#7858)", () => {
  const ALL_SET = {
    LOOPOVER_MINER_NEON_API_KEY: "neon-key",
    LOOPOVER_MINER_NEON_PROJECT_ID: "proj-1",
    LOOPOVER_MINER_NEON_PARENT_BRANCH_ID: "br-parent",
  };

  it("resolves a config when all three env vars are set", () => {
    expect(resolveAttemptDbForkConfig(ALL_SET)).toEqual({ apiKey: "neon-key", projectId: "proj-1", parentBranchId: "br-parent" });
  });

  it("trims whitespace from each value", () => {
    expect(
      resolveAttemptDbForkConfig({
        LOOPOVER_MINER_NEON_API_KEY: "  neon-key  ",
        LOOPOVER_MINER_NEON_PROJECT_ID: "\tproj-1\t",
        LOOPOVER_MINER_NEON_PARENT_BRANCH_ID: "\nbr-parent\n",
      }),
    ).toEqual({ apiKey: "neon-key", projectId: "proj-1", parentBranchId: "br-parent" });
  });

  it("returns null when no env vars are set at all", () => {
    expect(resolveAttemptDbForkConfig({})).toBeNull();
  });

  it.each(["LOOPOVER_MINER_NEON_API_KEY", "LOOPOVER_MINER_NEON_PROJECT_ID", "LOOPOVER_MINER_NEON_PARENT_BRANCH_ID"] as const)(
    "returns null when only %s is missing -- all three are required, not a majority",
    (missingKey) => {
      const partial = { ...ALL_SET, [missingKey]: undefined };
      expect(resolveAttemptDbForkConfig(partial)).toBeNull();
    },
  );

  it.each(["LOOPOVER_MINER_NEON_API_KEY", "LOOPOVER_MINER_NEON_PROJECT_ID", "LOOPOVER_MINER_NEON_PARENT_BRANCH_ID"] as const)(
    "treats a blank/whitespace-only %s the same as unset",
    (blankKey) => {
      const partial = { ...ALL_SET, [blankKey]: "   " };
      expect(resolveAttemptDbForkConfig(partial)).toBeNull();
    },
  );

  it("defaults to real process.env when no env argument is passed", () => {
    vi.stubEnv("LOOPOVER_MINER_NEON_API_KEY", "neon-key");
    vi.stubEnv("LOOPOVER_MINER_NEON_PROJECT_ID", "proj-1");
    vi.stubEnv("LOOPOVER_MINER_NEON_PARENT_BRANCH_ID", "br-parent");

    expect(resolveAttemptDbForkConfig()).toEqual({ apiKey: "neon-key", projectId: "proj-1", parentBranchId: "br-parent" });
  });
});
