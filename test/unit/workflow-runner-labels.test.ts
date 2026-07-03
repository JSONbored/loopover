import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("workflow runner labels", () => {
  it("runs CI validation on GitHub-hosted runners, not the (CPU-constrained) self-hosted pool (#2825)", () => {
    const workflow = read(".github/workflows/ci.yml");

    // validate-code previously ran on the fork-aware self-hosted/ubuntu-latest expression to reuse the VPS's
    // cached toolchain; while the self-hosted review stack is CPU constrained, EVERY job here runs on
    // ubuntu-latest instead, trusted PRs included (#2825). No runs-on line should still select the
    // self-hosted pool (explanatory comments mentioning "self-hosted" in prose are fine).
    const runsOnLines = workflow.match(/^\s*runs-on:.*$/gm) ?? [];
    expect(runsOnLines.length).toBeGreaterThan(0);
    for (const line of runsOnLines) expect(line).not.toMatch(/self-hosted|gittensory/);
    expect(workflow).not.toContain("|| 'self-hosted'");
    expect(workflow).not.toContain('"fork-ci"');
    expect(workflow).toContain("validate-code:");
    expect(workflow).toContain("needs: [changes, validate-code, security]");
    expect(workflow).not.toContain("\n  lint:\n");
    expect(workflow).not.toContain("\n  test:\n");
    expect(workflow).not.toContain("\n  workers:\n");
    expect(workflow).not.toContain("\n  mcp:\n");
    expect(workflow).not.toContain("\n  rees:\n");
    expect(workflow).not.toContain("\n  ui:\n");

    const changesJob = workflow.slice(workflow.indexOf("\n  changes:\n"), workflow.indexOf("\n  validate-code:\n"));
    expect(changesJob).toContain("runs-on: ubuntu-latest");
    const validateCodeJob = workflow.slice(workflow.indexOf("\n  validate-code:\n"), workflow.indexOf("\n  security:\n"));
    expect(validateCodeJob).toContain("runs-on: ubuntu-latest");
    const securityJob = workflow.slice(workflow.indexOf("\n  security:\n"), workflow.indexOf("\n  validate:\n"));
    expect(securityJob).toContain("runs-on: ubuntu-latest");
    const validateJob = workflow.slice(workflow.indexOf("\n  validate:\n"));
    expect(validateJob).toContain("runs-on: ubuntu-latest");
  });

  it("runs the scheduled dependency audit on GitHub-hosted runners too (#2825)", () => {
    const workflow = read(".github/workflows/audit.yml");

    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).not.toContain("self-hosted");
  });

  it("cancels a superseded selfhost.yml run instead of letting it run to completion (#2496)", () => {
    const workflow = read(".github/workflows/selfhost.yml");

    // Same push/pr split as ci.yml's own group, for the same reason: distinct main-branch pushes must not
    // cancel each other's validation, only a superseded run on the SAME ref/PR should be cancelled.
    expect(workflow).toContain(
      "group: selfhost-${{ github.ref }}-${{ github.event_name == 'push' && github.sha || 'pr' }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
    // Must be a literal boolean, not an expression -- ci.yml's own comment documents that an expression here
    // causes GitHub to fail the workflow at startup (startup_failure).
    expect(workflow).not.toMatch(/cancel-in-progress:\s*\$\{\{/);
  });
});
