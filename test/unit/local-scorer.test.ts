import { describe, expect, it } from "vitest";
import { computeLocalScorerTokens } from "../../src/signals/local-scorer";

describe("computeLocalScorerTokens (#782)", () => {
  it("classifies source / test / non-code from metadata and sums additions + deletions", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "src/foo.ts", additions: 10, deletions: 2 },
        { path: "src/foo.test.ts", additions: 8, deletions: 0 },
        { path: "README.md", additions: 5, deletions: 1 },
      ],
    });
    expect(scorer).toMatchObject({
      mode: "external_command",
      activeModel: "gittensory-deterministic",
      sourceTokenScore: 12,
      testTokenScore: 8,
      nonCodeTokenScore: 6,
      totalTokenScore: 26,
      sourceLines: 12,
    });
    expect(scorer.warnings).toBeUndefined();
  });

  it("drops binary files; with no source, sourceLines falls back to total (matching buildScorePreview)", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [
        { path: "img.png", additions: 100, binary: true },
        { path: "docs.md", additions: 3 },
      ],
    });
    expect(scorer.totalTokenScore).toBe(3); // the binary file carries no token value
    expect(scorer.sourceTokenScore).toBe(0);
    expect(scorer.nonCodeTokenScore).toBe(3);
    expect(scorer.sourceLines).toBe(3); // no source → falls back to total, floored at 1
  });

  it("floors sourceLines at 1 for a diff with no line counts at all", () => {
    const scorer = computeLocalScorerTokens({ changedFiles: [{ path: "docs.md" }] }); // additions/deletions omitted
    expect(scorer.totalTokenScore).toBe(0);
    expect(scorer.sourceLines).toBe(1);
  });

  it("surfaces a warning when local validation reports failures, without changing the scores", () => {
    const scorer = computeLocalScorerTokens({
      changedFiles: [{ path: "src/a.ts", additions: 4 }],
      validation: [
        { command: "npm test", status: "passed" },
        { command: "npm run typecheck", status: "failed" },
      ],
    });
    expect(scorer.sourceTokenScore).toBe(4);
    expect(scorer.warnings?.[0]).toMatch(/validation reported failures/i);
  });

  it("emits no warning when validation passed or was not supplied", () => {
    expect(computeLocalScorerTokens({ changedFiles: [{ path: "src/a.ts", additions: 1 }], validation: [{ command: "t", status: "passed" }] }).warnings).toBeUndefined();
    expect(computeLocalScorerTokens({ changedFiles: [{ path: "src/a.ts", additions: 1 }] }).warnings).toBeUndefined();
  });
});
