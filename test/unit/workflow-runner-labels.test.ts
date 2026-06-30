import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("workflow runner labels", () => {
  it("keeps trusted CI jobs on the gittensory runner pool and fork PRs on GitHub-hosted runners", () => {
    const workflow = read(".github/workflows/ci.yml");
    const trustedRunnerExpression =
      '${{ fromJSON((github.event_name == \'pull_request\' && github.event.pull_request.head.repo.fork == true) && \'["ubuntu-latest"]\' || \'["self-hosted","gittensory"]\') }}';

    expect(workflow.match(new RegExp(escapeRegExp(trustedRunnerExpression), "g")) ?? []).toHaveLength(9);
    expect(workflow).not.toContain("|| 'self-hosted'");
    expect(workflow).not.toContain('"fork-ci"');
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
