import { describe, expect, it } from "vitest";

// #6264: the three former MCP redaction call sites now share packages/loopover-mcp/lib/redact-local-path.js.
// This is the single home for the redaction contract, so it is tested once here; the call-site tests
// (local-scorer-adapter.test.ts, mcp-cli-packets.test.ts) still assert the wired-up behavior end to end.
const { redactLocalPath, redactKnownLocalPaths } = await import("../../packages/loopover-mcp/lib/redact-local-path.js");

describe("redactLocalPath (heuristic: detect an unknown path in free text)", () => {
  it("redacts an absolute unix path, preserving any leading delimiter", () => {
    expect(redactLocalPath("/home/user/proj/file.js")).toBe("<local-path>");
    expect(redactLocalPath("failed under /home/user/proj/file.js")).toBe("failed under <local-path>");
    expect(redactLocalPath('config="/etc/app/conf.d/main"')).toBe('config="<local-path>"');
  });

  it("redacts a path whose segments contain spaces (the space-aware validation shape)", () => {
    expect(redactLocalPath("node /Users/Alice Smith/project/run.js")).toBe("node <local-path>");
  });

  it("redacts both Windows slash forms and a home-anchored path", () => {
    expect(redactLocalPath("log=C:\\Users\\Alice Smith\\raw.log")).toBe("log=<local-path>");
    expect(redactLocalPath("C:/Users/bob/tmp/x")).toBe("<local-path>");
    expect(redactLocalPath("~/secrets/key.pem")).toBe("<local-path>");
    expect(redactLocalPath("~\\AppData\\Local\\thing")).toBe("<local-path>");
  });

  it("still redacts a home/Windows root that appears mid-token without a leading delimiter", () => {
    const redacted = redactLocalPath("see~/private/notes here");
    expect(redacted).toContain("<local-path>");
    expect(redacted).not.toContain("~/private");
  });

  // #6258: a Node.js stack-frame path (`at fn (/abs/path:line:col)`) previously leaked in full because
  // `(` was missing from the prefix delimiter class -- only a space-prefixed path redacted correctly.
  it("redacts a parenthesis-prefixed path (the Node.js stack-frame shape)", () => {
    // The trailing `:10:5` line/column suffix has no path separator before the closing `)`, so it's
    // swallowed into the same redacted match -- still a full, leak-free redaction either way.
    expect(redactLocalPath("at Object.<anonymous> (/Users/alice/secretproject/file.js:10:5)")).toBe(
      "at Object.<anonymous> (<local-path>)",
    );
  });

  it("redacts a bracket-prefixed path, preserving the closing bracket", () => {
    expect(redactLocalPath("[/Users/alice/secretproject/file.js]")).toBe("[<local-path>]");
  });

  it("redacts a colon-prefixed path with no space (e.g. `label:/abs/path`)", () => {
    expect(redactLocalPath("error:/Users/alice/secretproject/file.js")).toBe("error:<local-path>");
  });

  it("leaves text with no local path untouched, including a bare slash", () => {
    expect(redactLocalPath("just some text, version 1.2.3")).toBe("just some text, version 1.2.3");
    expect(redactLocalPath("pass --flag / or | here")).toBe("pass --flag / or | here");
  });

  it("coerces nullish and empty input to an empty string", () => {
    expect(redactLocalPath(undefined)).toBe("");
    expect(redactLocalPath(null)).toBe("");
    expect(redactLocalPath("")).toBe("");
  });
});

describe("redactKnownLocalPaths (exact substitution: redact a KNOWN token/path)", () => {
  it("replaces known tokens with [redacted] and known paths with [local-path]", () => {
    expect(redactKnownLocalPaths("token abc123 at /home/me/app", { tokens: ["abc123"], paths: ["/home/me/app"] })).toBe(
      "token [redacted] at [local-path]",
    );
  });

  it("applies the longest known path first so a shorter prefix cannot swallow the tail", () => {
    expect(redactKnownLocalPaths("/home/me/app/src/x", { paths: ["/home/me", "/home/me/app/src"] })).toBe("[local-path]/x");
  });

  it("ignores empty tokens, one-character paths, and non-string entries", () => {
    expect(redactKnownLocalPaths("keep / and x", { tokens: ["", 123 as unknown as string], paths: ["/", null as unknown as string] })).toBe(
      "keep / and x",
    );
  });

  it("coerces a non-string value before substituting", () => {
    expect(redactKnownLocalPaths(123, { tokens: ["2"] })).toBe("1[redacted]3");
  });

  it("passes undefined/null through untouched and defaults its options", () => {
    expect(redactKnownLocalPaths(undefined)).toBeUndefined();
    expect(redactKnownLocalPaths(null)).toBeNull();
    expect(redactKnownLocalPaths("plain text")).toBe("plain text");
  });
});
