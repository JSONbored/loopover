import { describe, expect, it } from "vitest";
import { classifyTestCoverage, hasLocalTestEvidence, isTestPath } from "../../src/signals/test-evidence";

describe("test evidence helpers", () => {
  it("detects common test path conventions", () => {
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("spec/models/widget_spec.rb")).toBe(true);
    expect(isTestPath("src/test/helpers.ts")).toBe(true);
    expect(isTestPath("tests/integration/api.test.ts")).toBe(true);
    expect(isTestPath("__tests__/widget.spec.tsx")).toBe(true);
    expect(isTestPath("src/widget.rs")).toBe(false);
  });

  it("treats explicit test file lists as evidence", () => {
    expect(hasLocalTestEvidence({ testFiles: ["internal/cache_test.go"] })).toBe(true);
    expect(hasLocalTestEvidence({ tests: [] })).toBe(false);
    expect(hasLocalTestEvidence({})).toBe(false);
  });
});

describe("classifyTestCoverage", () => {
  it("classifies an empty path list as absent", () => {
    expect(classifyTestCoverage([])).toBe("absent");
  });

  it("classifies a list with no test files as absent", () => {
    expect(classifyTestCoverage(["src/auth.ts", "src/utils.ts"])).toBe("absent");
  });

  it("classifies >= 40% test ratio as strong", () => {
    // 2 source + 2 test = 50%
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"])).toBe("strong");
  });

  it("classifies 20%–39% test ratio as adequate", () => {
    // 3 source + 1 test = 25%
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"])).toBe("adequate");
  });

  it("classifies > 0% but < 20% test ratio as weak", () => {
    // 9 source + 1 test ≈ 10%
    const sources = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
    expect(classifyTestCoverage([...sources, "test/single.test.ts"])).toBe("weak");
  });
});
