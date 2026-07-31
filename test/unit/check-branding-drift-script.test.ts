import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BRANDING_DRIFT_PATHSPECS, diffBrandingBaseline, scanBrandingHits } from "../../scripts/check-branding-drift";

// Mirrors git's own pathspec matching for patterns with no `:(glob)` magic: fnmatch(3) with FNM_PATHNAME
// OFF, so `*` (and therefore `**`, which collapses to the same thing under plain fnmatch) matches `/` too.
// This is deliberately NOT a shortcut like `path.startsWith(root)` -- it has to reproduce the exact
// depth-blind-or-not behavior `git grep` applies, so this test fails against the pre-fix `**/`-segmented list.
function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

function matchesPathspecs(pathspecs: readonly string[], file: string): boolean {
  const includes = pathspecs.filter((spec) => !spec.startsWith(":(exclude)"));
  const excludes = pathspecs.filter((spec) => spec.startsWith(":(exclude)")).map((spec) => spec.slice(":(exclude)".length));
  const included = includes.some((spec) => globToRegExp(spec).test(file));
  const excluded = excludes.some((spec) => globToRegExp(spec).test(file));
  return included && !excluded;
}

describe("scanBrandingHits", () => {
  it("parses git grep -c output into a { file: count } map", () => {
    const exec = () => "src/a.ts:2\nsrc/b.ts:1\n";
    const result = scanBrandingHits({ root: "/fake", exec });

    expect(result).toEqual({ "src/a.ts": 2, "src/b.ts": 1 });
  });

  it("returns an empty map when there is no output (git grep found nothing)", () => {
    const exec = () => "";
    const result = scanBrandingHits({ root: "/fake", exec });

    expect(result).toEqual({});
  });

  it("uses the LAST colon as the file/count separator, so a path containing a colon still parses", () => {
    const exec = () => "src/weird:name.ts:3\n";
    const result = scanBrandingHits({ root: "/fake", exec });

    expect(result).toEqual({ "src/weird:name.ts": 3 });
  });

  it("passes the branding-drift pathspecs through to the injected exec", () => {
    let capturedArgs: string[] = [];
    const exec = (_root: string, args: string[]) => {
      capturedArgs = args;
      return "";
    };
    scanBrandingHits({ root: "/fake", exec });

    expect(capturedArgs[0]).toBe("grep");
    expect(capturedArgs).toContain("src/*.ts");
    expect(capturedArgs).toContain(":(exclude)**/*.test.ts");
  });

  it("scans apps/* workspaces the same way it scans packages/* (src .ts/.tsx and scripts .mjs)", () => {
    let capturedArgs: string[] = [];
    const exec = (_root: string, args: string[]) => {
      capturedArgs = args;
      return "";
    };
    scanBrandingHits({ root: "/fake", exec });

    expect(capturedArgs).toContain("apps/*/src/*.ts");
    expect(capturedArgs).toContain("apps/*/src/*.tsx");
    expect(capturedArgs).toContain("apps/*/scripts/*.mjs");
  });

  it("scans packages/*/src/*.tsx, so ui-kit design-system components are covered like apps/* .tsx are", () => {
    let capturedArgs: string[] = [];
    const exec = (_root: string, args: string[]) => {
      capturedArgs = args;
      return "";
    };
    scanBrandingHits({ root: "/fake", exec });

    expect(capturedArgs).toContain("packages/*/src/*.tsx");
  });

  it("includes a packages/*/src/*.tsx hit in the scanned set (a ui-kit component now in scope)", () => {
    const exec = () => "packages/loopover-ui-kit/src/card.tsx:1\n";
    const result = scanBrandingHits({ root: "/fake", exec });

    expect(result).toEqual({ "packages/loopover-ui-kit/src/card.tsx": 1 });
  });

  // Real regression guard, mirroring check-manifest-drift-script.test.ts's own real-repo-state test: proves
  // the actual defaultExec (real `git grep` subprocess, real exit-1-means-empty handling) works against this
  // repo's real tracked files, not just the injected fake above.
  it("runs the real git grep against this repo without throwing", () => {
    const result = scanBrandingHits({ root: process.cwd() });

    expect(typeof result).toBe("object");
    for (const count of Object.values(result)) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe("diffBrandingBaseline", () => {
  it("reports no failures when baseline and current match exactly", () => {
    const failures = diffBrandingBaseline({ "src/a.ts": 2 }, { "src/a.ts": 2 });

    expect(failures).toEqual([]);
  });

  it("flags a file whose count increased (new drift)", () => {
    const failures = diffBrandingBaseline({ "src/a.ts": 1 }, { "src/a.ts": 2 });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("src/a.ts");
    expect(failures[0]).toContain("increased from 1 to 2");
    expect(failures[0]).toContain("branding-drift:update");
  });

  it("flags a brand-new file not present in the baseline at all (increased from 0)", () => {
    const failures = diffBrandingBaseline({}, { "src/new.ts": 1 });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("increased from 0 to 1");
  });

  it("detects a new gittensory hit under an apps/*/src path as drift, now that apps/* is in scope", () => {
    const failures = diffBrandingBaseline({}, { "apps/loopover-ui/src/routes/app.new.tsx": 1 });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("apps/loopover-ui/src/routes/app.new.tsx");
    expect(failures[0]).toContain("increased from 0 to 1");
  });

  it("flags a file whose count decreased (stale baseline after a cleanup)", () => {
    const failures = diffBrandingBaseline({ "src/a.ts": 3 }, { "src/a.ts": 1 });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("decreased from 3 to 1");
  });

  it("flags a file removed entirely from current (decreased to 0)", () => {
    const failures = diffBrandingBaseline({ "src/gone.ts": 2 }, {});

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("decreased from 2 to 0");
  });

  it("reports one failure per affected file, sorted, when several files differ", () => {
    const failures = diffBrandingBaseline({ "src/b.ts": 1, "src/a.ts": 1 }, { "src/b.ts": 2, "src/a.ts": 2 });

    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("src/a.ts");
    expect(failures[1]).toContain("src/b.ts");
  });
});

describe("BRANDING_DRIFT_PATHSPECS depth coverage (regression for #10045)", () => {
  // Each row is a root that used to be written `<root>/**/*.<ext>`. A depth-0 file (directly inside the
  // root) and a nested file must both match; a file outside the root must not. Against the pre-fix `**/`
  // form, `depthZero` fails to match (the exact bug this issue is about) while `nested` and `outside` still
  // pass -- so this table only turns fully green once every affected pathspec drops its `**/` segment.
  const CASES = [
    { root: "src/*.ts", depthZero: "src/index.ts", nested: "src/api/routes.ts", outside: "docs/index.ts" },
    { root: "src/*.tsx", depthZero: "src/App.tsx", nested: "src/components/App.tsx", outside: "docs/App.tsx" },
    {
      root: "packages/*/src/*.ts",
      depthZero: "packages/discovery-index/src/app.ts",
      nested: "packages/discovery-index/src/ingest/app.ts",
      outside: "packages/discovery-index/test/app.ts",
    },
    {
      root: "packages/*/src/*.tsx",
      depthZero: "packages/loopover-ui-kit/src/card.tsx",
      nested: "packages/loopover-ui-kit/src/components/card.tsx",
      outside: "packages/loopover-ui-kit/test/card.tsx",
    },
    {
      // outside deliberately avoids bin/ -- packages/*/bin/** matches every file under bin/ regardless
      // of extension, so a bin/ path would pass for the wrong reason.
      root: "packages/*/lib/*.js",
      depthZero: "packages/loopover-mcp/lib/tools.js",
      nested: "packages/loopover-mcp/lib/resources/tools.js",
      outside: "packages/loopover-mcp/test/tools.js",
    },
    {
      root: "packages/*/lib/*.ts",
      depthZero: "packages/loopover-mcp/lib/tools.ts",
      nested: "packages/loopover-mcp/lib/resources/tools.ts",
      outside: "packages/loopover-mcp/test/tools.ts",
    },
    {
      root: "packages/*/scripts/*.mjs",
      depthZero: "packages/loopover-engine/scripts/build.mjs",
      nested: "packages/loopover-engine/scripts/codegen/build.mjs",
      outside: "packages/loopover-engine/test/build.mjs",
    },
    {
      root: "apps/*/src/*.ts",
      depthZero: "apps/loopover-ui/src/main.ts",
      nested: "apps/loopover-ui/src/lib/main.ts",
      outside: "apps/loopover-ui/scripts/main.ts",
    },
    {
      root: "apps/*/src/*.tsx",
      depthZero: "apps/loopover-ui/src/main.tsx",
      nested: "apps/loopover-ui/src/routes/main.tsx",
      outside: "apps/loopover-ui/scripts/main.tsx",
    },
    {
      root: "apps/*/scripts/*.mjs",
      depthZero: "apps/loopover-ui/scripts/build.mjs",
      nested: "apps/loopover-ui/scripts/codegen/build.mjs",
      outside: "apps/loopover-ui/src/build.mjs",
    },
  ] as const;

  it.each(CASES)("$root matches a depth-0 file, still matches a nested file, and rejects an outside file", ({ root, depthZero, nested, outside }) => {
    expect(BRANDING_DRIFT_PATHSPECS).toContain(root);
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, depthZero)).toBe(true);
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, nested)).toBe(true);
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, outside)).toBe(false);
  });

  it("packages/*/bin/** is untouched -- a bare ** tail already matches every depth, including depth 0", () => {
    expect(BRANDING_DRIFT_PATHSPECS).toContain("packages/*/bin/**");
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, "packages/loopover-mcp/bin/cli.js")).toBe(true);
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, "packages/loopover-mcp/bin/nested/cli.js")).toBe(true);
  });

  it("still excludes test files at every depth, including depth 0", () => {
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, "src/index.test.ts")).toBe(false);
    expect(matchesPathspecs(BRANDING_DRIFT_PATHSPECS, "packages/loopover-mcp/test/tools.ts")).toBe(false);
  });

  it("contains no **/ path segment except packages/*/bin/** and the three untouched :(exclude) entries", () => {
    const allowedDoubleStarEntries = ["packages/*/bin/**", ":(exclude)**/*.test.ts", ":(exclude)**/*.test.tsx", ":(exclude)packages/*/test/**"];
    for (const spec of BRANDING_DRIFT_PATHSPECS) {
      if (spec.includes("**")) {
        expect(allowedDoubleStarEntries).toContain(spec);
      }
    }
  });
});

describe("check-branding-drift script (real repo state)", () => {
  // Most important test in this file: proves the checked-in baseline actually matches the real repo right
  // now. If this fails, real drift landed (or a cleanup did) without regenerating the baseline -- either way,
  // fix it with `npm run branding-drift:update`, don't weaken this test.
  it("the committed baseline matches the real current repo state (regression guard)", () => {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-branding-drift.ts"], { encoding: "utf8" });

    expect(output).toMatch(/Branding-drift check ok: \d+ file\(s\) match the recorded baseline\./);
  });
});
