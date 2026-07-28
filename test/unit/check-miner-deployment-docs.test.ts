import { describe, expect, it, vi } from "vitest";
import {
  buildLiveContainerCommandClaims,
  buildLiveMinerDeploymentReality,
  main,
  runMinerDeploymentDocsAudit,
} from "../../scripts/check-miner-deployment-docs";

describe("check-miner-deployment-docs (#6158)", () => {
  it("passes against the live miner DEPLOYMENT.md and source tree", () => {
    const result = runMinerDeploymentDocsAudit();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.claimCounts.envVars).toBeGreaterThan(0);
    expect(result.claimCounts.filePaths).toBeGreaterThan(0);
    expect(result.claimCounts.subcommands).toBeGreaterThan(0);
    // Both fleet-mode manifests (docker-compose.miner.yml, k8s/miner-deployment.yaml) have a genuine
    // command/args claim, proving the container-manifest audit actually read and parsed real files rather
    // than trivially passing on an empty claim set.
    expect(result.claimCounts.containerCommands).toBe(2);
  });

  it("buildLiveContainerCommandClaims reads both fleet-mode manifests' real commands", () => {
    const claims = buildLiveContainerCommandClaims();
    expect(claims).toEqual([
      { source: "packages/loopover-miner/docker-compose.miner.yml", command: "loop" },
      { source: "k8s/miner-deployment.yaml", command: "loop" },
    ]);
  });

  it("fails when a fleet-mode container manifest's command is forced unregistered (drift fixture)", () => {
    expect(() => runMinerDeploymentDocsAudit({ testMode: "bad-container-command" })).toThrow(
      /Fleet-mode container manifests are out of sync/i,
    );
  });

  it("main exits non-zero on the forced-unregistered-container-command drift fixture", () => {
    const exit = vi.fn();
    const error = vi.fn();
    const log = vi.fn();
    const code = main(
      { CHECK_MINER_DEPLOYMENT_DOCS_AUDIT_TEST_MODE: "bad-container-command" },
      { log, error, exit },
    );
    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Fleet-mode container manifests are out of sync/i));
    expect(log).not.toHaveBeenCalled();
  });

  it("exposes the live env-var read set as an enumerable field for the reverse audit (#6601)", () => {
    const reality = buildLiveMinerDeploymentReality();
    const reads = [...reality.envReads];
    // Populated, and includes a var the reverse check now requires DEPLOYMENT.md to document.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads).toContain("LOOPOVER_MINER_LOG_LEVEL");
    // The enumerable set and the boolean probe agree.
    expect(reads.every((name) => reality.hasEnvRead(name))).toBe(true);
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
