import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("workflow runner labels", () => {
  it("keeps only the build/test job on the gittensory runner pool; non-build jobs run on GitHub-hosted runners", () => {
    const workflow = read(".github/workflows/ci.yml");
    const trustedRunnerExpression =
      '${{ fromJSON((github.event_name == \'pull_request\' && github.event.pull_request.head.repo.fork == true) && \'["ubuntu-latest"]\' || \'["self-hosted","gittensory"]\') }}';

    // Only validate-code (the npm/build/test job that benefits from the self-hosted VPS's cached toolchain)
    // stays on the fork-aware trusted-pool expression. changes/security/validate do no build/test work, so
    // they're unconditionally ubuntu-latest -- fanning them out to self-hosted only competed with
    // validate-code for the same scarce runner pool (#2501, #2507).
    expect(workflow.match(new RegExp(escapeRegExp(trustedRunnerExpression), "g")) ?? []).toHaveLength(1);
    expect(workflow).toContain("validate-code:");
    expect(workflow).toContain("needs: [changes, validate-code, security]");
    expect(workflow).not.toContain("\n  lint:\n");
    expect(workflow).not.toContain("\n  test:\n");
    expect(workflow).not.toContain("\n  workers:\n");
    expect(workflow).not.toContain("\n  mcp:\n");
    expect(workflow).not.toContain("\n  rees:\n");
    expect(workflow).not.toContain("\n  ui:\n");
    expect(workflow).not.toContain("|| 'self-hosted'");
    expect(workflow).not.toContain('"fork-ci"');

    const changesJob = workflow.slice(workflow.indexOf("\n  changes:\n"), workflow.indexOf("\n  validate-code:\n"));
    expect(changesJob).toContain("runs-on: ubuntu-latest");
    const securityJob = workflow.slice(workflow.indexOf("\n  security:\n"), workflow.indexOf("\n  validate:\n"));
    expect(securityJob).toContain("runs-on: ubuntu-latest");
    const validateJob = workflow.slice(workflow.indexOf("\n  validate:\n"));
    expect(validateJob).toContain("runs-on: ubuntu-latest");
  });

  it("keeps scheduled audit work on the trusted self-hosted pool", () => {
    const workflow = read(".github/workflows/audit.yml");

    expect(workflow).toContain("runs-on: [self-hosted, gittensory]");
    expect(workflow).not.toContain("|| 'self-hosted'");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
