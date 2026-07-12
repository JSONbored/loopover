import { describe, expect, it } from "vitest";
import { parsePrNumberFromExecResult } from "../../packages/gittensory-miner/lib/pr-number-parse.js";

describe("parsePrNumberFromExecResult (#4848)", () => {
  it("extracts the real PR number from a real gh pr create stdout URL, scoped to the exact repo", () => {
    expect(
      parsePrNumberFromExecResult({ code: 0, stdout: "https://github.com/acme/widgets/pull/123\n", timedOut: false }, "acme/widgets"),
    ).toBe(123);
  });

  it("returns null when execResult is missing, timed out, or exited non-zero", () => {
    expect(parsePrNumberFromExecResult(null, "acme/widgets")).toBeNull();
    expect(parsePrNumberFromExecResult(undefined, "acme/widgets")).toBeNull();
    expect(parsePrNumberFromExecResult({ code: 0, stdout: "https://github.com/acme/widgets/pull/1", timedOut: true }, "acme/widgets")).toBeNull();
    expect(parsePrNumberFromExecResult({ code: 1, stdout: "https://github.com/acme/widgets/pull/1", timedOut: false }, "acme/widgets")).toBeNull();
  });

  it("returns null when stdout is not a string, or has no matching URL", () => {
    expect(parsePrNumberFromExecResult({ code: 0, stdout: undefined, timedOut: false }, "acme/widgets")).toBeNull();
    expect(parsePrNumberFromExecResult({ code: 0, stdout: "no url here", timedOut: false }, "acme/widgets")).toBeNull();
  });

  it("REGRESSION: never matches a URL for a DIFFERENT repo, even if it looks similar", () => {
    expect(
      parsePrNumberFromExecResult({ code: 0, stdout: "https://github.com/acme/other-repo/pull/9\n", timedOut: false }, "acme/widgets"),
    ).toBeNull();
  });

  it("scoping regex-escapes the repo name so a special character can't widen the match", () => {
    expect(
      parsePrNumberFromExecResult({ code: 0, stdout: "https://github.com/acme/widgets/pull/9\n", timedOut: false }, "acme/widget."),
    ).toBeNull();
  });

  it("REGRESSION: a matched but non-positive number (e.g. pull/0) is rejected, not returned as-is", () => {
    expect(
      parsePrNumberFromExecResult({ code: 0, stdout: "https://github.com/acme/widgets/pull/0\n", timedOut: false }, "acme/widgets"),
    ).toBeNull();
  });
});
