import { describe, expect, it } from "vitest";

import { resolveActionlintDownloadAttempts } from "../../scripts/lib/actionlint-download-attempts.mjs";

// #7773: an explicit ACTIONLINT_DOWNLOAD_ATTEMPTS="0" must be respected (floored to 1), not silently turned
// into the default of 4 by a `parseInt(...) || 4` fallback (0 is falsy).
describe("resolveActionlintDownloadAttempts (#7773)", () => {
  it("respects an explicit 0, flooring it to 1 (not the default 4)", () => {
    expect(resolveActionlintDownloadAttempts("0")).toBe(1);
  });

  it("defaults to 4 when unset, blank, or non-integer", () => {
    expect(resolveActionlintDownloadAttempts(undefined)).toBe(4);
    expect(resolveActionlintDownloadAttempts("")).toBe(4);
    expect(resolveActionlintDownloadAttempts("abc")).toBe(4);
  });

  it("honors an explicit positive integer", () => {
    expect(resolveActionlintDownloadAttempts("1")).toBe(1);
    expect(resolveActionlintDownloadAttempts("7")).toBe(7);
  });

  it("floors a negative value to 1", () => {
    expect(resolveActionlintDownloadAttempts("-3")).toBe(1);
  });
});
