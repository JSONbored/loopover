import { describe, expect, it } from "vitest";
import {
  REVIEW_THREAD_BLOCKER_CODE,
  buildReviewThreadBlocker,
  reviewThreadBlockerFinding,
} from "../../src/review/review-thread-findings";

describe("buildReviewThreadBlocker", () => {
  it("returns null when there is no non-empty comment", () => {
    expect(buildReviewThreadBlocker({ comments: [] })).toBeNull();
    expect(buildReviewThreadBlocker({ comments: [{ body: "   " }, { body: null }, {}] })).toBeNull();
  });

  it("uses the first non-empty comment (no scanner marker) and carries its metadata through", () => {
    const b = buildReviewThreadBlocker({
      path: "src/a.ts",
      line: 12,
      comments: [{ body: "Please fix this", authorLogin: "alice", url: "https://x/1" }],
    });
    expect(b).not.toBeNull();
    expect(b!.title).toBe("Please fix this");
    expect(b!.scannerFinding).toBe(false);
    expect(b!.priority).toBeUndefined();
    expect(b!.authorLogin).toBe("alice");
    expect(b!.url).toBe("https://x/1");
    expect(b!.path).toBe("src/a.ts");
    expect(b!.line).toBe(12);
  });

  it("prefers a scanner-marked comment over an earlier plain one and extracts a markdown priority + title", () => {
    const b = buildReviewThreadBlocker({
      comments: [
        { body: "a human note first" },
        { body: "<!-- brin-pr-finding -->\n**P1: ** Null deref here", authorLogin: "bot" },
      ],
    });
    expect(b!.scannerFinding).toBe(true);
    expect(b!.priority).toBe("P1");
    expect(b!.title).toBe("Null deref here");
    expect(b!.authorLogin).toBe("bot");
  });

  it("extracts an XML priority + title when no markdown priority is present", () => {
    const b = buildReviewThreadBlocker({
      comments: [{ body: "<priority>P0</priority><title> Crash on empty input </title>" }],
    });
    expect(b!.priority).toBe("P0");
    expect(b!.title).toBe("Crash on empty input");
  });

  it("falls back to the first meaningful line, skipping markup wrappers", () => {
    const b = buildReviewThreadBlocker({
      comments: [{ body: "<!-- marker -->\n<details>\n<summary>x</summary>\n```\nActual meaningful line" }],
    });
    expect(b!.title).toBe("Actual meaningful line");
    expect(b!.priority).toBeUndefined();
  });

  it("falls back to the literal 'review thread' when a comment is only markup", () => {
    const b = buildReviewThreadBlocker({ comments: [{ body: "<!-- only markup -->" }] });
    expect(b!.title).toBe("review thread");
    expect(b!.scannerFinding).toBe(false);
  });

  it("strips tags/markdown, collapses whitespace, and truncates the title to 180 chars", () => {
    const long = "x".repeat(200);
    const b = buildReviewThreadBlocker({ comments: [{ body: `**P2: **  <b>Some</b>  \`title\`   ${long}` }] });
    expect(b!.priority).toBe("P2");
    expect(b!.title.length).toBe(180);
    expect(b!.title.startsWith("Some title ")).toBe(true);
    expect(b!.title).not.toContain("<b>");
    expect(b!.title).not.toContain("`");
  });
});

describe("reviewThreadBlockerFinding", () => {
  it("renders a critical finding with actor, priority, and a path:line location", () => {
    const f = reviewThreadBlockerFinding({
      title: "Null deref",
      priority: "P1",
      path: "src/a.ts",
      line: 9,
      authorLogin: "bob",
      scannerFinding: true,
    });
    expect(f.code).toBe(REVIEW_THREAD_BLOCKER_CODE);
    expect(f.severity).toBe("critical");
    expect(f.title).toBe("bob review thread unresolved: P1 Null deref (src/a.ts:9)");
    expect(f.detail).toContain("at src/a.ts:9");
  });

  it("uses the path only when the line is non-positive, and omits actor/priority", () => {
    const f = reviewThreadBlockerFinding({ title: "Fix it", path: "src/b.ts", line: 0, scannerFinding: false });
    expect(f.title).toBe("review thread unresolved: Fix it (src/b.ts)");
  });

  it("omits the location entirely when there is no path", () => {
    const f = reviewThreadBlockerFinding({ title: "No location", scannerFinding: false });
    expect(f.title).toBe("review thread unresolved: No location");
    expect(f.detail).not.toContain(" at ");
  });
});
