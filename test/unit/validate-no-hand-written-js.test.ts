// Tests for the TypeScript lock (#9527).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { ALLOWLIST, classify, isAllowed, isGenerated } from "../../scripts/validate-no-hand-written-js";

describe("isAllowed", () => {
  it("matches an exact allowlisted path", () => {
    expect(isAllowed("apps/loopover-ui/public/sw.js")).toBe(true);
    expect(isAllowed("apps/loopover-ui/public/other.js")).toBe(false);
  });

  it("matches any path under a directory-prefix entry", () => {
    expect(isAllowed("test/fixtures/local-scorer/scorer-success.mjs")).toBe(true);
    expect(isAllowed("test/fixtures/deeply/nested/child.mjs")).toBe(true);
    expect(isAllowed("test/unit/something.mjs")).toBe(false);
  });
});

describe("isGenerated", () => {
  it("exempts generated typegen declarations wherever they live", () => {
    expect(isGenerated("worker-configuration.d.ts")).toBe(true);
    expect(isGenerated("control-plane/worker-configuration.d.ts")).toBe(true);
  });

  it("does not exempt a hand-written declaration", () => {
    expect(isGenerated("src/env.d.ts")).toBe(false);
  });
});

describe("classify", () => {
  it("flags hand-written JavaScript that is neither allowed nor generated", () => {
    const { violations } = classify(["scripts/rogue.mjs", "src/fine.ts", "scripts/rogue.cjs", "apps/x/rogue.js"]);
    expect(violations).toEqual(["scripts/rogue.mjs", "scripts/rogue.cjs", "apps/x/rogue.js"]);
  });

  it("flags a hand-written .d.ts but not a generated one", () => {
    const { violations } = classify(["some/hand.d.ts", "worker-configuration.d.ts"]);
    expect(violations).toEqual(["some/hand.d.ts"]);
  });

  it("ignores TypeScript and every other extension", () => {
    const { violations } = classify(["src/a.ts", "docs/b.md", "c.json", "d.py", "e.sql"]);
    expect(violations).toEqual([]);
  });

  it("does not flag an allowlisted path", () => {
    const { violations } = classify(["apps/loopover-ui/public/sw.js", "test/fixtures/x/child.mjs"]);
    expect(violations).toEqual([]);
  });

  it("reports an allowlist entry that matches nothing tracked", () => {
    // The anti-rot guard: a watched path that silently stops existing is exactly how metagraphed's
    // MCP version-sync workflow died unnoticed. Here it fails the build instead.
    const { staleAllowlist } = classify([]);
    expect(staleAllowlist.length).toBe(ALLOWLIST.length);
    expect(staleAllowlist).toContain("apps/loopover-ui/public/sw.js");
  });

  it("reports no stale entries when every allowlisted path is present", () => {
    const tracked = ALLOWLIST.map((entry) => (entry.path.endsWith("/") ? `${entry.path}child.mjs` : entry.path));
    expect(classify(tracked).staleAllowlist).toEqual([]);
  });
});

describe("the allowlist itself", () => {
  it("gives every entry a substantive reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, entry.path).toBeGreaterThan(30);
    }
  });

  it("has no duplicate paths", () => {
    const paths = ALLOWLIST.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("the repository itself", () => {
  it("contains no hand-written JavaScript outside the allowlist", () => {
    // The real gate, run against the real tree -- so a violation fails here too, not only in the
    // dedicated test:ci step.
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const { violations, staleAllowlist } = classify(tracked);
    expect(violations).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });
});
