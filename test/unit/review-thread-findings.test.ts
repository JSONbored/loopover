import { describe, expect, it } from "vitest";
import {
  REVIEW_THREAD_BLOCKER_CODE,
  buildReviewThreadBlocker,
  reviewThreadBlockerFinding,
} from "../../src/review/review-thread-findings";

describe("review thread blocker parsing", () => {
  it("returns null when every comment body is empty", () => {
    expect(
      buildReviewThreadBlocker({
        path: "src/a.ts",
        line: 4,
        comments: [{ body: "  " }, { body: null }],
      }),
    ).toBeNull();
  });

  it("prefers scanner-marked comments and parses markdown priority titles", () => {
    const blocker = buildReviewThreadBlocker({
      path: "src/a.ts",
      line: 12,
      comments: [
        { body: "Please fix this naming.", authorLogin: "human" },
        {
          body: "<!-- brin-pr-finding -->\n**P1:** Leaked secret in config",
          authorLogin: "brin",
          url: "https://github.com/o/r/pull/1#discussion_r1",
        },
      ],
    });
    expect(blocker).toMatchObject({
      title: "Leaked secret in config",
      priority: "P1",
      path: "src/a.ts",
      line: 12,
      authorLogin: "brin",
      scannerFinding: true,
    });
  });

  it("parses XML priority/title markers and formats advisory findings with locations", () => {
    const blocker = buildReviewThreadBlocker({
      path: "pkg/main.go",
      line: 0,
      comments: [
        {
          body: "<priority>P2</priority><title>Race in shutdown hook</title>",
          authorLogin: "reviewer",
        },
      ],
    });
    expect(blocker).toMatchObject({
      title: "Race in shutdown hook",
      priority: "P2",
      scannerFinding: false,
    });

    const finding = reviewThreadBlockerFinding(blocker!);
    expect(finding.code).toBe(REVIEW_THREAD_BLOCKER_CODE);
    expect(finding.title).toMatch(/reviewer review thread unresolved: P2 Race in shutdown hook/);
    expect(finding.detail).toMatch(/pkg\/main\.go/);
    expect(finding.detail).not.toMatch(/pkg\/main\.go:/);
  });
});
