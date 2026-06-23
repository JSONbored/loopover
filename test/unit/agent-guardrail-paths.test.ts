import { describe, expect, it } from "vitest";
import { changedPathsForGuardrail } from "../../src/queue/processors";
import type { PullRequestFileRecord } from "../../src/types";

function file(path: string, previousFilename?: string | null): PullRequestFileRecord {
  return {
    repoFullName: "JSONbored/gittensory",
    pullNumber: 42,
    path,
    previousFilename,
    status: previousFilename ? "renamed" : "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    payload: { filename: path },
  };
}

describe("changedPathsForGuardrail", () => {
  it("includes previous filenames so guarded renames still force manual review", () => {
    expect(changedPathsForGuardrail([file("docs/deploy-renamed.md", "scripts/deploy.sh")])).toEqual(["docs/deploy-renamed.md", "scripts/deploy.sh"]);
  });

  it("deduplicates current and previous filenames", () => {
    expect(changedPathsForGuardrail([file("scripts/deploy.sh", "scripts/deploy.sh")])).toEqual(["scripts/deploy.sh"]);
  });
});
