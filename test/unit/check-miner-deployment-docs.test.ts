import { describe, expect, it, vi } from "vitest";
import {
  buildLiveMinerDeploymentReality,
  main,
  runMinerDeploymentDocsAudit,
} from "../../scripts/check-miner-deployment-docs.mjs";

describe("check-miner-deployment-docs (#6158)", () => {
  it("passes against the live miner DEPLOYMENT.md and source tree", () => {
    const result = runMinerDeploymentDocsAudit();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.claimCounts.envVars).toBeGreaterThan(0);
    expect(result.claimCounts.filePaths).toBeGreaterThan(0);
    expect(result.claimCounts.subcommands).toBeGreaterThan(0);
  });

  it("fails when env-var backing reads are forced missing (drift fixture)", () => {
    expect(() => runMinerDeploymentDocsAudit({ testMode: "missing-env" })).toThrow(/DEPLOYMENT\.md is out of sync/i);
  });

  it("main exits non-zero on the forced-missing-env drift fixture", () => {
    const exit = vi.fn();
    const error = vi.fn();
    const log = vi.fn();
    const code = main(
      { CHECK_MINER_DEPLOYMENT_DOCS_AUDIT_TEST_MODE: "missing-env" },
      { log, error, exit },
    );
    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/DEPLOYMENT\.md is out of sync/i));
    expect(log).not.toHaveBeenCalled();
  });

  it("buildLiveMinerDeploymentReality populates the enumerable envReads field (#6601)", () => {
    const reality = buildLiveMinerDeploymentReality();
    const envReads = [...reality.envReads];
    expect(envReads.length).toBeGreaterThan(0);
    expect(envReads).toContain("LOOPOVER_MINER_LOG_LEVEL");
    // Every token reality.hasEnvRead reports true for must also appear in the enumerable set -- the two
    // must agree, since hasEnvRead is just a membership test over the same underlying set.
    expect(reality.hasEnvRead("LOOPOVER_MINER_LOG_LEVEL")).toBe(true);
  });

  it("main prints ok and returns 0 on the live tree", () => {
    const exit = vi.fn();
    const error = vi.fn();
    const log = vi.fn();
    const code = main({}, { log, error, exit });
    expect(code).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Miner deployment docs audit ok:/));
  });
});
