import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runAudit(env: Record<string, string | undefined> = {}): { status: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, ["packages/loopover-miner/scripts/check-deployment-docs-audit.mjs"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, out: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("check-deployment-docs-audit script (#6158)", () => {
  it("passes on the real miner deployment docs and live source tree", () => {
    const result = runAudit();
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^Miner deployment docs audit ok:/);
  });

  it("fails with a drift-style message when env-var backing reads are forced missing", () => {
    const result = runAudit({ CHECK_MINER_DEPLOYMENT_DOCS_AUDIT_TEST_MODE: "missing-env" });
    expect(result.status).toBe(1);
    expect(result.out).toContain("DEPLOYMENT.md is out of sync");
    expect(result.out).toContain("is documented in DEPLOYMENT.md but no read of it exists");
  });
});
