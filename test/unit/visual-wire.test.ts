import { describe, expect, it } from "vitest";
import { isScreenshotsEnabled, screenshotsAllowed } from "../../src/review/visual-wire";

describe("isScreenshotsEnabled", () => {
  it("is OFF by default (unset / empty / false)", () => {
    expect(isScreenshotsEnabled({})).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: undefined })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "false" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "0" })).toBe(false);
    expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: "off" })).toBe(false);
  });

  it("accepts the codebase truthy vocabulary (1/true/yes/on, case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "ON"]) {
      expect(isScreenshotsEnabled({ GITTENSORY_REVIEW_SCREENSHOTS: v }), v).toBe(true);
    }
  });
});

describe("screenshotsAllowed (global flag AND per-repo cutover gate)", () => {
  const repo = "JSONbored/gittensory";

  it("requires BOTH the global flag and the repo allowlist", () => {
    // Global on, repo allowlisted → allowed.
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: repo }, repo)).toBe(true);
  });

  it("is false when the global flag is OFF even if the repo is allowlisted", () => {
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "false", GITTENSORY_REVIEW_REPOS: repo }, repo)).toBe(false);
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_REPOS: repo }, repo)).toBe(false);
  });

  it("is false when the repo is NOT allowlisted even if the global flag is ON (dormant default)", () => {
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "true" }, repo)).toBe(false);
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: "" }, repo)).toBe(false);
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "true", GITTENSORY_REVIEW_REPOS: "JSONbored/other" }, repo)).toBe(false);
  });

  it("matches the repo case-insensitively within the allowlist", () => {
    expect(screenshotsAllowed({ GITTENSORY_REVIEW_SCREENSHOTS: "on", GITTENSORY_REVIEW_REPOS: "jsonbored/GITTENSORY" }, repo)).toBe(true);
  });
});
