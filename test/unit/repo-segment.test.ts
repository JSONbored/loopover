import { describe, expect, it } from "vitest";

import { REPO_SEGMENT_PATTERN, isValidRepoSegment } from "../../packages/loopover-engine/src/index";

describe("shared repo-segment path-safety guard (#9610)", () => {
  it("re-exports the guard from the engine barrel", () => {
    expect(REPO_SEGMENT_PATTERN).toBeInstanceOf(RegExp);
    expect(typeof isValidRepoSegment).toBe("function");
  });

  it("accepts GitHub-legal slug segments", () => {
    expect(isValidRepoSegment("acme")).toBe(true);
    expect(isValidRepoSegment("a.b_c-d9")).toBe(true);
    expect(isValidRepoSegment("...three-dots-are-a-slug...")).toBe(true);
  });

  it("rejects a segment outside [A-Za-z0-9._-]", () => {
    expect(isValidRepoSegment("evil repo")).toBe(false);
    expect(isValidRepoSegment("")).toBe(false);
    expect(isValidRepoSegment("a/b")).toBe(false);
  });

  it("rejects the bare '.' and '..' traversal segments", () => {
    expect(isValidRepoSegment(".")).toBe(false);
    expect(isValidRepoSegment("..")).toBe(false);
  });
});
