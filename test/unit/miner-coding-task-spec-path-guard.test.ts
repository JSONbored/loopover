import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as realRelative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    relative: vi.fn(actual.relative),
  };
});

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { relative } from "node:path";
import {
  buildCodingTaskAcceptanceCriteria,
  buildCodingTaskFeasibility,
  writeAcceptanceCriteriaFile,
} from "../../packages/loopover-miner/lib/coding-task-spec.js";

const roots: string[] = [];

afterEach(() => {
  vi.mocked(relative).mockImplementation(realRelative);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-coding-task-path-"));
  roots.push(root);
  return realpathSync(root);
}

function issue() {
  return {
    repoFullName: "acme/widgets",
    number: 7,
    title: "Uploads should retry on 5xx",
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    htmlUrl: "https://github.com/acme/widgets/issues/7",
    body: "Uploads fail silently.",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    labels: ["bug"],
    linkedPrs: [],
  };
}

function claimLedger() {
  return { listClaims: () => [] };
}

describe("writeAcceptanceCriteriaFile path containment (#5132 / #7313)", () => {
  it("refuses to write when the resolved path escapes the worktree root", () => {
    const dir = tempDir();
    vi.mocked(relative).mockReturnValue("../escape");
    const target = issue();
    const feasibility = buildCodingTaskFeasibility(
      "acme/widgets",
      target,
      { issues: [target], pullRequests: [] },
      claimLedger() as never,
    );
    const doc = buildCodingTaskAcceptanceCriteria(
      { number: 7, title: target.title, body: target.body, labels: target.labels },
      feasibility,
    );

    expect(() => writeAcceptanceCriteriaFile(dir, doc)).toThrow(
      /Refusing to write acceptance criteria outside the worktree/,
    );
  });
});
