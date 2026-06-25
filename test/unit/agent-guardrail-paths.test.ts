import { describe, expect, it } from "vitest";
import { changedPathsForGuardrail, hasVerifiedRequiredContexts } from "../../src/queue/processors";
import { isGuardrailHit } from "../../src/signals/change-guardrail";
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

  it("keeps comment-side guardrail holds aligned for guarded file renames (#guarded-hold-comment)", () => {
    const renamed = [file("docs/ci-copy.yml", ".github/workflows/ci.yml")];

    expect(isGuardrailHit(changedPathsForGuardrail(renamed), [".github/workflows/**"])).toBe(true);
  });
});

describe("hasVerifiedRequiredContexts (#1177)", () => {
  it("verifies only a non-empty required-context set", () => {
    expect(hasVerifiedRequiredContexts(new Set(["validate"]))).toBe(true);
  });

  it("does NOT verify when branch protection was unreadable (null)", () => {
    expect(hasVerifiedRequiredContexts(null)).toBe(false);
  });

  it("does NOT verify when no contexts are required (empty set) — a red check is then optional/third-party", () => {
    expect(hasVerifiedRequiredContexts(new Set())).toBe(false);
  });
});
