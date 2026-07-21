import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { diffBrandingBaseline, scanBrandingHits } from "../../scripts/check-branding-drift.js";

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
    expect(capturedArgs).toContain("src/**/*.ts");
    expect(capturedArgs).toContain(":(exclude)**/*.test.ts");
  });

  it("scans apps/* workspaces the same way it scans packages/* (src .ts/.tsx and scripts .mjs)", () => {
    let capturedArgs: string[] = [];
    const exec = (_root: string, args: string[]) => {
      capturedArgs = args;
      return "";
    };
    scanBrandingHits({ root: "/fake", exec });

    expect(capturedArgs).toContain("apps/*/src/**/*.ts");
    expect(capturedArgs).toContain("apps/*/src/**/*.tsx");
    expect(capturedArgs).toContain("apps/*/scripts/**/*.mjs");
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

describe("check-branding-drift script (real repo state)", () => {
  // Most important test in this file: proves the checked-in baseline actually matches the real repo right
  // now. If this fails, real drift landed (or a cleanup did) without regenerating the baseline -- either way,
  // fix it with `npm run branding-drift:update`, don't weaken this test.
  it("the committed baseline matches the real current repo state (regression guard)", () => {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-branding-drift.ts"], { encoding: "utf8" });

    expect(output).toMatch(/Branding-drift check ok: \d+ file\(s\) match the recorded baseline\./);
  });
});
