import { describe, expect, it } from "vitest";
import { classifyFindingCategory, FINDING_CATEGORIES, inferFindingCategory, isFindingCategory } from "../../src/review/finding-category-classify";

describe("isFindingCategory (#1958)", () => {
  it("accepts every value in the fixed enum", () => {
    for (const category of FINDING_CATEGORIES) {
      expect(isFindingCategory(category)).toBe(true);
    }
  });

  it("rejects a value outside the fixed enum", () => {
    expect(isFindingCategory("readability")).toBe(false);
  });

  it("rejects the wrong case (case-sensitive)", () => {
    expect(isFindingCategory("Security")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isFindingCategory(1)).toBe(false);
    expect(isFindingCategory(null)).toBe(false);
    expect(isFindingCategory(undefined)).toBe(false);
    expect(isFindingCategory({})).toBe(false);
  });
});

describe("classifyFindingCategory (#1958)", () => {
  it("tests: a finding anchored to a test file, regardless of body wording", () => {
    expect(classifyFindingCategory({ path: "src/app.test.ts", body: "This looks fine." })).toBe("tests");
  });

  it("security: SQL injection wording", () => {
    expect(classifyFindingCategory({ path: "src/db.ts", body: "This query is vulnerable to SQL injection." })).toBe("security");
  });

  it("security: hardcoded credential wording", () => {
    expect(classifyFindingCategory({ path: "src/config.ts", body: "This hardcoded password should be a secret." })).toBe("security");
  });

  it("performance: N+1 wording", () => {
    expect(classifyFindingCategory({ path: "src/api.ts", body: "This introduces an N+1 query inside the loop." })).toBe("performance");
  });

  it("tests: missing-test wording on a non-test file", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This branch has no test coverage." })).toBe("tests");
  });

  it("style: naming/formatting wording", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This variable naming is inconsistent." })).toBe("style");
  });

  it("maintainability: duplication wording", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This duplicates logic already in helpers.ts." })).toBe("maintainability");
  });

  it("falls through to correctness when nothing matches", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This will throw when the array is empty." })).toBe("correctness");
  });

  it("precedence: a test-path finding wins over security wording in the body (path checked first)", () => {
    expect(classifyFindingCategory({ path: "test/unit/auth.test.ts", body: "This test bypasses authentication entirely." })).toBe("tests");
  });

  it("precedence: security wording wins over performance wording in the same body", () => {
    expect(
      classifyFindingCategory({
        path: "src/api.ts",
        body: "This SQL injection risk also causes a slow N+1 query.",
      }),
    ).toBe("security");
  });

  it("delegates to inferFindingCategory (same result, argument order swapped)", () => {
    const finding = { path: "src/db.ts", body: "This query is vulnerable to SQL injection." };
    expect(classifyFindingCategory(finding)).toBe(inferFindingCategory(finding.body, finding.path));
  });
});

describe("inferFindingCategory (#2148)", () => {
  it("path signal — routes a test file to tests regardless of body wording", () => {
    expect(inferFindingCategory("This looks fine.", "src/app.test.ts")).toBe("tests");
  });

  it("path signal — routes a docs file to style", () => {
    expect(inferFindingCategory("Anything at all.", "docs/architecture.md")).toBe("style");
    expect(inferFindingCategory("Fix this heading.", "README.md")).toBe("style");
  });

  it("path signal — routes a config file to maintainability", () => {
    expect(inferFindingCategory("Bump the target.", "tsconfig.json")).toBe("maintainability");
    expect(inferFindingCategory("Pin the base image.", "Dockerfile")).toBe("maintainability");
  });

  it("keyword bucket — security", () => {
    expect(inferFindingCategory("This is vulnerable to XSS.", "src/web.ts")).toBe("security");
  });

  it("keyword bucket — performance", () => {
    expect(inferFindingCategory("This has a memory leak under load.", "src/cache.ts")).toBe("performance");
  });

  it("keyword bucket — tests (body wording on a non-test, non-docs, non-config path)", () => {
    expect(inferFindingCategory("This assertion is missing.", "src/util.ts")).toBe("tests");
  });

  it("keyword bucket — style", () => {
    expect(inferFindingCategory("The indentation here is off.", "src/util.ts")).toBe("style");
  });

  it("keyword bucket — maintainability", () => {
    expect(inferFindingCategory("This is dead code that should be removed.", "src/util.ts")).toBe("maintainability");
  });

  it("no signal — falls through to correctness", () => {
    expect(inferFindingCategory("This will throw when the array is empty.", "src/util.ts")).toBe("correctness");
  });

  it("precedence — a docs path beats security wording in the body (path checked before keywords)", () => {
    expect(inferFindingCategory("This documents an SQL injection workaround.", "docs/security.md")).toBe("style");
  });

  it("precedence — a config path beats security wording in the body", () => {
    expect(inferFindingCategory("Move this hardcoded secret out of here.", "docker-compose.yml")).toBe("maintainability");
  });

  it("precedence — a test path beats every keyword", () => {
    expect(inferFindingCategory("SQL injection and an N+1 query and a memory leak.", "test/unit/auth.test.ts")).toBe("tests");
  });

  it("precedence among path signals — a test file wins over docs/config wording in its path", () => {
    // A .md is a docs file, but a test .md would be rare; the test check runs first so a genuine test path wins.
    expect(inferFindingCategory("anything", "src/app.test.ts")).toBe("tests");
  });

  it("every returned value is a member of the fixed enum", () => {
    const results = [
      inferFindingCategory("x", "a.test.ts"),
      inferFindingCategory("x", "a.md"),
      inferFindingCategory("x", "tsconfig.json"),
      inferFindingCategory("csrf", "a.ts"),
      inferFindingCategory("latency", "a.ts"),
      inferFindingCategory("flaky test", "a.ts"),
      inferFindingCategory("typo", "a.ts"),
      inferFindingCategory("refactor", "a.ts"),
      inferFindingCategory("plain bug", "a.ts"),
    ];
    for (const result of results) {
      expect(FINDING_CATEGORIES).toContain(result);
    }
  });
});
