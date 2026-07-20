import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRepoStack,
  RECOGNIZED_MANIFESTS,
  renderStackSummary,
} from "../../packages/loopover-miner/lib/stack-detection.js";

const ROOT = "/repo";

/** Build injected `existsSync` / `readFileSync` doubles over a relative-path -> content map. A `null` value models a
 * file that is listed (exists) but throws on read (e.g. EACCES / a binary). */
function fakeFs(files: Record<string, string | null>) {
  const rels = Object.keys(files);
  const full = (rel: string) => join(ROOT, rel);
  const present = new Set(rels.map(full));
  return {
    existsSync: (path: string) => present.has(path),
    readFileSync: (path: string) => {
      const rel = rels.find((candidate) => full(candidate) === path);
      if (rel === undefined || files[rel] === null) throw new Error(`ENOENT: ${path}`);
      return files[rel] as string;
    },
  };
}

function detect(files: Record<string, string | null>) {
  return detectRepoStack(ROOT, fakeFs(files));
}

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);

describe("detectRepoStack — fail-closed (#4785)", () => {
  it("returns detected:false with a clear reason when no manifest is present", () => {
    const result = detect({ "README.md": "# hi", "src/index.txt": "x" });
    expect(result).toEqual({ detected: false, reason: expect.stringContaining("No recognized") });
  });

  it("requires a repository path", () => {
    expect(detectRepoStack("")).toEqual({
      detected: false,
      reason: "A repository path is required to detect the stack.",
    });
    expect(detectRepoStack(123 as never).detected).toBe(false);
    expect(detectRepoStack("   ").detected).toBe(false);
  });

  it("treats an fs that throws on exists as 'file absent' (never crashes)", () => {
    const result = detectRepoStack(ROOT, {
      existsSync: () => {
        throw new Error("EACCES");
      },
      readFileSync: () => "",
    });
    expect(result.detected).toBe(false);
  });

  it("exposes the recognized-manifest precedence list", () => {
    expect(RECOGNIZED_MANIFESTS).toContain("package.json");
    expect(RECOGNIZED_MANIFESTS).toContain("Cargo.toml");
    expect(Object.isFrozen(RECOGNIZED_MANIFESTS)).toBe(true);
  });
});

describe("detectRepoStack — Node (#4785)", () => {
  it("detects a plain JavaScript repo defaulting to npm with no commands", () => {
    expect(detect({ "package.json": pkg({}) })).toEqual({
      detected: true,
      language: "javascript",
      packageManager: "npm",
      buildCommand: null,
      testCommand: null,
      lintCommand: null,
      formatCommand: null,
      evidence: { manifest: "package.json", lockfile: null },
    });
  });

  it("classifies TypeScript via tsconfig.json or a typescript dependency", () => {
    expect(detect({ "package.json": pkg({}), "tsconfig.json": "{}" }).detected && "typescript").toBe("typescript");
    const viaDep = detect({ "package.json": pkg({ devDependencies: { typescript: "^5.4.0" } }) });
    expect(viaDep).toMatchObject({ detected: true, language: "typescript" });
  });

  it("derives full build/test/lint/format commands from package.json scripts", () => {
    const result = detect({
      "package.json": pkg({
        scripts: { build: "tsc", test: "vitest", lint: "eslint .", format: "prettier -w ." },
      }),
    });
    expect(result).toMatchObject({
      buildCommand: "npm run build",
      testCommand: "npm test",
      lintCommand: "npm run lint",
      formatCommand: "npm run format",
    });
  });

  it("matches script name variants and ignores non-string script values", () => {
    const result = detect({
      "package.json": pkg({
        scripts: { build: 123, "compile:prod": "tsc -p .", "test:ci": "vitest run", "lint:fix": "eslint --fix", fmt: "biome format" },
      }),
    });
    expect(result).toMatchObject({
      buildCommand: "npm run compile:prod",
      testCommand: "npm run test:ci",
      lintCommand: "npm run lint:fix",
      formatCommand: "npm run fmt",
    });
  });

  it("resolves the package manager from the corepack field over any lockfile", () => {
    const result = detect({ "package.json": pkg({ packageManager: "pnpm@8.15.0" }), "yarn.lock": "" });
    expect(result).toMatchObject({ packageManager: "pnpm" });
  });

  it("ignores an unknown corepack value and falls back to the lockfile / npm", () => {
    expect(detect({ "package.json": pkg({ packageManager: "deno@1" }) })).toMatchObject({ packageManager: "npm" });
  });

  it("resolves the package manager from each supported lockfile", () => {
    expect(detect({ "package.json": pkg({}), "pnpm-lock.yaml": "" })).toMatchObject({ packageManager: "pnpm", evidence: { lockfile: "pnpm-lock.yaml" } });
    expect(detect({ "package.json": pkg({}), "yarn.lock": "" })).toMatchObject({ packageManager: "yarn" });
    expect(detect({ "package.json": pkg({}), "bun.lockb": "" })).toMatchObject({ packageManager: "bun" });
    expect(detect({ "package.json": pkg({}), "package-lock.json": "" })).toMatchObject({ packageManager: "npm", evidence: { lockfile: "package-lock.json" } });
  });

  it("degrades safely on an unparseable or unreadable package.json (still Node, no commands)", () => {
    expect(detect({ "package.json": "{ not json" })).toMatchObject({ detected: true, language: "javascript", buildCommand: null });
    // Present but unreadable (read throws -> null).
    expect(detect({ "package.json": null })).toMatchObject({ detected: true, language: "javascript" });
    // Valid JSON that is not an object (number / bool / string) → parseJson returns null, still Node.
    expect(detect({ "package.json": "42" })).toMatchObject({ detected: true, language: "javascript", buildCommand: null });
    expect(detect({ "package.json": "true" })).toMatchObject({ detected: true, language: "javascript", buildCommand: null });
  });

  it("treats a non-string readFileSync result as no content", () => {
    const result = detectRepoStack(ROOT, {
      existsSync: (path: string) => path === join(ROOT, "package.json"),
      readFileSync: () => 123 as never,
    });
    expect(result).toMatchObject({ detected: true, language: "javascript" });
  });

  it("ignores a non-object scripts field", () => {
    expect(detect({ "package.json": pkg({ scripts: ["build"] }) })).toMatchObject({ buildCommand: null, testCommand: null });
  });
});

describe("detectRepoStack — Python (#4785)", () => {
  it("detects a pip repo from requirements.txt with no guessed commands", () => {
    expect(detect({ "requirements.txt": "requests\n" })).toEqual({
      detected: true,
      language: "python",
      packageManager: "pip",
      buildCommand: null,
      testCommand: null,
      lintCommand: null,
      formatCommand: null,
      evidence: { manifest: "requirements.txt", lockfile: null },
    });
  });

  it("detects poetry via [tool.poetry] and builds with poetry when a build-system is declared", () => {
    expect(detect({ "pyproject.toml": "[tool.poetry]\n[build-system]\nrequires = []\n" })).toMatchObject({
      packageManager: "poetry",
      buildCommand: "poetry build",
      evidence: { manifest: "pyproject.toml", lockfile: null },
    });
    expect(detect({ "pyproject.toml": "", "poetry.lock": "" })).toMatchObject({ packageManager: "poetry", evidence: { lockfile: "poetry.lock" }, buildCommand: null });
  });

  it("detects uv and pipenv and pip build-system", () => {
    expect(detect({ "pyproject.toml": "[build-system]\n", "uv.lock": "" })).toMatchObject({ packageManager: "uv", buildCommand: "python -m build", evidence: { lockfile: "uv.lock" } });
    expect(detect({ "Pipfile": "" })).toMatchObject({ packageManager: "pipenv", evidence: { lockfile: null } });
    expect(detect({ "requirements.txt": "", "Pipfile.lock": "" })).toMatchObject({ packageManager: "pipenv", evidence: { lockfile: "Pipfile.lock" } });
    expect(detect({ "pyproject.toml": "[build-system]\n" })).toMatchObject({ packageManager: "pip", buildCommand: "python -m build" });
  });

  it("infers ruff lint/format and pytest only from real config", () => {
    expect(detect({ "pyproject.toml": "[tool.ruff]\n" })).toMatchObject({ lintCommand: "ruff check .", formatCommand: "ruff format ." });
    expect(detect({ "requirements.txt": "", "ruff.toml": "" })).toMatchObject({ lintCommand: "ruff check ." });
    expect(detect({ "requirements.txt": "", ".ruff.toml": "" })).toMatchObject({ lintCommand: "ruff check ." });
    expect(detect({ "pyproject.toml": "[tool.pytest.ini_options]\n" })).toMatchObject({ testCommand: "pytest" });
    expect(detect({ "setup.py": "", "pytest.ini": "" })).toMatchObject({ testCommand: "pytest", evidence: { manifest: "setup.py" } });
    expect(detect({ "setup.cfg": "", "tox.ini": "" })).toMatchObject({ testCommand: "pytest", evidence: { manifest: "setup.cfg" } });
  });
});

describe("detectRepoStack — Rust / Go / JVM (#4785)", () => {
  it("detects Rust with the canonical cargo toolchain", () => {
    expect(detect({ "Cargo.toml": "" })).toEqual({
      detected: true,
      language: "rust",
      packageManager: "cargo",
      buildCommand: "cargo build",
      testCommand: "cargo test",
      lintCommand: "cargo clippy",
      formatCommand: "cargo fmt",
      evidence: { manifest: "Cargo.toml", lockfile: null },
    });
    expect(detect({ "Cargo.toml": "", "Cargo.lock": "" })).toMatchObject({ evidence: { lockfile: "Cargo.lock" } });
  });

  it("detects Go, using go vet by default and golangci-lint when configured", () => {
    expect(detect({ "go.mod": "" })).toMatchObject({ language: "go", lintCommand: "go vet ./...", evidence: { lockfile: null } });
    for (const config of [".golangci.yml", ".golangci.yaml", ".golangci.toml"]) {
      expect(detect({ "go.mod": "", "go.sum": "", [config]: "" })).toMatchObject({ lintCommand: "golangci-lint run", evidence: { lockfile: "go.sum" } });
    }
  });

  it("detects Maven and Gradle (wrapper-aware)", () => {
    expect(detect({ "pom.xml": "" })).toMatchObject({ language: "java", packageManager: "maven", buildCommand: "mvn -B package", lintCommand: null });
    expect(detect({ "build.gradle": "" })).toMatchObject({ packageManager: "gradle", buildCommand: "gradle build" });
    expect(detect({ "build.gradle.kts": "", "gradlew": "" })).toMatchObject({ buildCommand: "./gradlew build", evidence: { manifest: "build.gradle.kts" } });
  });
});

describe("detectRepoStack — precedence + summary (#4785)", () => {
  it("resolves the first matching manifest when several are present", () => {
    expect(detect({ "package.json": pkg({}), "pyproject.toml": "" })).toMatchObject({ language: "javascript" });
  });

  it("renders a one-line summary for detected and undetected results", () => {
    const detected = detect({
      "package.json": pkg({ scripts: { build: "tsc" } }),
      "tsconfig.json": "{}",
    });
    expect(renderStackSummary(detected)).toBe("typescript via npm (build=`npm run build`)");

    expect(renderStackSummary(detect({ "Cargo.toml": "" }))).toContain("rust via cargo");
    expect(renderStackSummary(detect({}))).toContain("stack not detected:");
    expect(renderStackSummary(undefined as never)).toBe("stack not detected: unknown reason");
    // No commands detected.
    expect(renderStackSummary(detect({ "pom.xml": "" }))).toContain("java via maven");
    expect(renderStackSummary(detect({ "requirements.txt": "" }))).toContain("no validation commands detected");
    // packageManager null arm.
    expect(
      renderStackSummary({
        detected: true,
        language: "elixir",
        packageManager: null,
        buildCommand: null,
        testCommand: null,
        lintCommand: null,
        formatCommand: null,
        evidence: { manifest: "mix.exs", lockfile: null },
      }),
    ).toContain("elixir via unknown");
  });
});
