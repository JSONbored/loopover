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
    expect(workflow).toContain("needs: [changes, validate-code, validate-tests]");
    expect(workflow).not.toContain("\n  lint:\n");
    expect(workflow).not.toContain("\n  test:\n");
    expect(workflow).not.toContain("\n  workers:\n");
    expect(workflow).not.toContain("\n  mcp:\n");
    expect(workflow).not.toContain("\n  rees:\n");
    expect(workflow).not.toContain("\n  ui:\n");

    const changesJob = workflow.slice(workflow.indexOf("\n  changes:\n"), workflow.indexOf("\n  validate-code:\n"));
    expect(changesJob).toContain("runs-on: ubuntu-latest");
    const validateCodeJob = workflow.slice(workflow.indexOf("\n  validate-code:\n"), workflow.indexOf("\n  validate-tests:\n"));
    expect(validateCodeJob).toContain("runs-on: ubuntu-latest");
    // validate-tests (#ci-shard-coverage) is the unsharded full-suite coverage run, split out of
    // validate-code so the long suite never serializes with the much-faster checks (unsharded again
    // 2026-07 -- see the job's header comment in ci.yml; the old merge job is gone with the shards).
    const validateTestsJob = workflow.slice(workflow.indexOf("\n  validate-tests:\n"), workflow.indexOf("\n  validate:\n"));
    expect(validateTestsJob).toContain("runs-on: ubuntu-latest");
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

    // Push-only workflow since 2026-07-24: sha-scoped so distinct main-branch pushes never cancel each
    // other's validation (the old push/pr split went with the pull_request trigger).
    expect(workflow).toContain("group: selfhost-${{ github.sha }}");
    expect(workflow).toContain("cancel-in-progress: true");
    // Must be a literal boolean, not an expression -- ci.yml's own comment documents that an expression here
    // causes GitHub to fail the workflow at startup (startup_failure).
    expect(workflow).not.toMatch(/cancel-in-progress:\s*\$\{\{/);
  });
});
