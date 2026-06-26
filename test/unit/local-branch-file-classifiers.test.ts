import { describe, expect, it } from "vitest";

import { isCodeFile, isTestFile } from "../../src/signals/local-branch";

describe("isTestFile", () => {
  it("matches test/spec directories anywhere in the path", () => {
    for (const path of [
      "test/example.ts",
      "tests/example.ts",
      "spec/example.rb",
      "__tests__/component.tsx",
      "packages/api/test/helper.go",
      "services/worker/tests/worker.py",
      "app/models/spec/user.rb",
      "frontend/src/__tests__/button.jsx",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it("matches the src/test convention", () => {
    for (const path of [
      "src/test/setup.ts",
      "packages/core/src/test/fixtures.ts",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it("matches go/python/ruby _test suffix files", () => {
    for (const path of [
      "handler_test.go",
      "pkg/server/router_test.go",
      "service_test.py",
      "app/jobs/cleanup_test.py",
      "models/account_test.rb",
      "HANDLER_TEST.GO",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it("matches ruby _spec suffix files", () => {
    for (const path of ["user_spec.rb", "spec/models/user_spec.rb"]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it("matches dotted .test/.spec source files across supported extensions", () => {
    for (const path of [
      "math.test.ts",
      "Button.spec.tsx",
      "client.test.js",
      "widget.spec.jsx",
      "calc.test.py",
      "user.spec.rb",
      "engine.test.rs",
      "Engine.Test.TS",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it("does not flag production sources or lookalike directory names", () => {
    for (const path of [
      "src/index.ts",
      "src/signals/local-branch.ts",
      "README.md",
      "testing/util.ts",
      "contest/entry.ts",
      "specs/openapi.ts",
    ]) {
      expect(isTestFile(path)).toBe(false);
    }
  });

  it("does not flag near-miss suffixes that fall outside the patterns", () => {
    for (const path of [
      "helper_test.ts",
      "helper_test.js",
      "config_spec.py",
      "foo.testing.ts",
      "notes.test.md",
    ]) {
      expect(isTestFile(path)).toBe(false);
    }
  });

  it("delegates to test-evidence isTestPath so matchers stay in sync", () => {
    expect(isTestFile("tests/integration/api.test.ts")).toBe(true);
  });
});

describe("isCodeFile", () => {
  it("matches supported programming-language extensions", () => {
    for (const path of [
      "src/index.ts",
      "components/Button.tsx",
      "scripts/build.js",
      "pages/home.jsx",
      "service/main.py",
      "lib/parser.rb",
      "engine/core.rs",
      "android/App.kt",
      "etl/Job.scala",
      "server/Main.java",
      "cmd/server/main.go",
      "migrations/0001_init.sql",
      "helper_test.ts",
    ]) {
      expect(isCodeFile(path)).toBe(true);
    }
  });

  it("excludes files that are themselves test files even with code extensions", () => {
    for (const path of [
      "math.test.ts",
      "Button.spec.tsx",
      "handler_test.go",
      "service_test.py",
      "models/account_test.rb",
      "__tests__/component.jsx",
    ]) {
      expect(isCodeFile(path)).toBe(false);
    }
  });

  it("excludes non-code assets and extensionless files", () => {
    for (const path of [
      "README.md",
      "package.json",
      "assets/logo.png",
      "styles/site.css",
      "docs/notes.txt",
      "Dockerfile",
      "config.yaml",
    ]) {
      expect(isCodeFile(path)).toBe(false);
    }
  });
});
