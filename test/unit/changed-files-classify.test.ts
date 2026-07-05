import { describe, expect, it } from "vitest";
import { classifyChangedFile } from "../../src/review/changed-files-classify";
import { isConfigFile, isDocsFile, isGeneratedFile, isLockfile, isMinifiedFile, isVendoredFile } from "../../src/signals/path-matchers";
import { isTestFile } from "../../src/signals/local-branch";

describe("classifyChangedFile (#2143)", () => {
  it("source: plain hand-authored code that matches no other bucket", () => {
    expect(classifyChangedFile("src/app.ts")).toBe("source");
  });

  it("test: a test file", () => {
    expect(isTestFile("src/app.test.ts")).toBe(true);
    expect(classifyChangedFile("src/app.test.ts")).toBe("test");
  });

  it("docs: a markdown doc", () => {
    expect(isDocsFile("docs/guide.md")).toBe(true);
    expect(classifyChangedFile("docs/guide.md")).toBe("docs");
  });

  it("config: a config file", () => {
    expect(isConfigFile(".eslintrc.json")).toBe(true);
    expect(classifyChangedFile(".eslintrc.json")).toBe("config");
  });

  it("generated: generated / vendored / lockfile / minified all fold to generated", () => {
    expect(isGeneratedFile("src/api.generated.ts")).toBe(true);
    expect(classifyChangedFile("src/api.generated.ts")).toBe("generated");
    expect(isLockfile("package-lock.json")).toBe(true);
    expect(classifyChangedFile("package-lock.json")).toBe("generated");
    expect(isVendoredFile("vendor/jquery.js")).toBe(true);
    expect(classifyChangedFile("vendor/jquery.js")).toBe("generated");
    expect(isMinifiedFile("dist/app.min.js")).toBe(true);
    expect(classifyChangedFile("dist/app.min.js")).toBe("generated");
  });

  it("precedence: a vendored file that is ALSO a test → generated (generated > test)", () => {
    expect(isTestFile("vendor/foo.test.js")).toBe(true); // it is a test file
    expect(isVendoredFile("vendor/foo.test.js")).toBe(true); // and vendored
    expect(classifyChangedFile("vendor/foo.test.js")).toBe("generated"); // generated outranks test
  });

  it("unknown → source (the 5-bucket set has no 'other')", () => {
    expect(classifyChangedFile("assets/logo.bin")).toBe("source");
  });
});
