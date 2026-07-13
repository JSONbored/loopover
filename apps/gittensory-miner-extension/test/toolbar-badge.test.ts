import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeToolbarBadge,
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
} from "../toolbar-badge.js";

describe("computeToolbarBadge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the count with the has-data color when candidates are populated", () => {
    expect(computeToolbarBadge([{}, {}, {}])).toEqual({
      text: "3",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
    expect(computeToolbarBadge([{}])).toEqual({
      text: "1",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
  });

  it("clears the text for an empty array", () => {
    expect(computeToolbarBadge([])).toEqual({
      text: "",
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("shows a dash for never-populated or malformed values", () => {
    for (const malformed of [undefined, null, "12", 7, { length: 5 }, true]) {
      expect(computeToolbarBadge(malformed)).toEqual({
        text: TOOLBAR_BADGE_NO_DATA_TEXT,
        backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
      });
    }
  });
});
