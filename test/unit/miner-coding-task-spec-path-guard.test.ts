import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// REGRESSION coverage for assertContainedPath's throw arm in coding-task-spec.ts (#5132): under normal
// operation ACCEPTANCE_CRITERIA_FILENAME is a fixed, safe basename ("acceptance-criteria.json"), so
// join(root, ACCEPTANCE_CRITERIA_FILENAME) can never actually escape root -- miner-coding-task-spec.test.ts
// exercises every other branch of this file but can't reach this one through that fixed constant. This file
// mocks @loopover/engine's ACCEPTANCE_CRITERIA_FILENAME export to a path-traversal value to prove the
// defense-in-depth guard actually fires if that upstream constant were ever a non-basename (e.g. a future
// @loopover/engine regression), rather than deleting the check as unreachable dead code.
vi.mock("@loopover/engine", async () => {
  const actual = await import("../../packages/loopover-engine/src/index");
  return { ...actual, ACCEPTANCE_CRITERIA_FILENAME: "../escape.json" };
});

import { writeAcceptanceCriteriaFile } from "../../packages/loopover-miner/lib/coding-task-spec.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-coding-task-spec-path-guard-"));
  roots.push(root);
  return realpathSync(root);
}

function goAcceptanceCriteria() {
  return {
    version: 1,
    verdict: "go" as const,
    writable: true,
    taskBrief: "brief",
    constraints: "",
    feasibilityNotes: "",
    retrievalContext: "",
    feasibilitySummary: "",
    avoidReasons: [],
    raiseReasons: [],
  };
}

describe("coding-task-spec assertContainedPath (#5132)", () => {
  it("REGRESSION: refuses to write outside the worktree when the acceptance-criteria filename escapes root", () => {
    const workingDirectory = tempDir();
    expect(() => writeAcceptanceCriteriaFile(workingDirectory, goAcceptanceCriteria())).toThrow(
      /Refusing to write acceptance criteria outside the worktree/,
    );
  });
});
