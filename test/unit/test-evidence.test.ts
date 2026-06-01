import { describe, expect, it } from "vitest";
import { hasLocalTestEvidence, isTestPath } from "../../src/signals/test-evidence";

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
