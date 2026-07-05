import { isCodeFile, isTestFile } from "./local-branch";
import { isTestPath } from "./test-evidence";

// Pure, deterministic path matchers for slop classification (#561). Siblings to `isTestFile` /
// `isTestPath`: they identify changed files that are NOT genuine hand-authored effort — machine-
// generated output, vendored/imported third-party code, minified bundles, dependency lockfiles, and
// docs — so slop signals can tell a padded diff from real work. Path-only and side-effect-free.

function normalize(path: string): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function basename(path: string): string {
  const norm = normalize(path);
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

function extension(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/**
 * Shared "normalised parts" struct so callers (notably `classifyChangedFile`) can normalise a path
 * once and pass the pre-computed pieces to every `isX` helper. The exported `isX(path)` functions
 * still normalise on their own for callers that don't share a hot loop, so the public contract is
 * unchanged — the struct is an internal fast path.
 */
type NormalizedPath = {
  norm: string;
  base: string;
  ext: string;
};

function normalizeForMatch(path: string): NormalizedPath {
  const norm = normalize(path);
  const slash = norm.lastIndexOf("/");
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  return { norm, base, ext };
}

function isGeneratedFileFrom(parts: NormalizedPath): boolean {
  const { norm, base } = parts;
  return (
    /(^|\/)(__generated__|generated)\//.test(norm) ||
    /\.(generated|gen)\.[^/]+$/.test(norm) ||
    // protoc output: Go/TS/JS plugins emit `.pb.{go,ts,js}`, the reference C++ plugin emits
    // `.pb.cc` / `.pb.h`, the Swift plugin emits `.pb.swift`, the Dart plugin emits `.pb.dart`,
    // the Kotlin plugin emits `.pb.kt`, and the C# plugin emits `.pb.cs`.
    // `.pb.dart`/`.pb.kt`/`.pb.cs` (the `.pb` infix keeps hand-written sources from matching).
    /\.pb\.(go|ts|js|cc|h|swift|dart|kt|cs)$/.test(norm) ||
    // Python protobuf: message stubs are `*_pb2.py[i]`; the gRPC plugin emits sibling
    // `*_pb2_grpc.py[i]` service stubs, which are the same machine-generated output.
    /_pb2(_grpc)?\.pyi?$/.test(norm) ||
    // Dart codegen: build_runner (`.g.dart`), freezed (`.freezed.dart`), and
    // retrofit/injectable (`.gr.dart`) all emit generated part files.
    /\.(g|freezed|gr)\.dart$/.test(norm) ||
    // C# codegen: WinForms/WPF designer partials (`.designer.cs`) and XAML/T4 output (`.g.cs`).
    /\.(designer|g)\.cs$/.test(norm) ||
    // Source maps for every first-class JS/TS bundle extension. `.mjs`/`.cjs` are already
    // recognized code extensions (isCodeFile), so their bundlers' `.mjs.map` / `.cjs.map`
    // maps are generated output too — the same as `.js.map`.
    /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|mdx|scss|sass|less|html|css)\.map$/.test(norm) ||
    base === "worker-configuration.d.ts"
  );
}

function isVendoredFileFrom(parts: NormalizedPath): boolean {
  // bower_components (Bower) and jspm_packages (JSPM) are installed-dependency
  // directories — the same vendored case as node_modules, not contributor source.
  return /(^|\/)(vendor|vendored|third_party|third-party|node_modules|bower_components|jspm_packages)\//.test(
    parts.norm,
  );
}

function isLockfileFrom(parts: NormalizedPath): boolean {
  return LOCKFILE_NAMES.has(parts.base);
}

function isMinifiedFileFrom(parts: NormalizedPath): boolean {
  return /\.min\.[a-z0-9]+$/.test(parts.norm);
}

function isDocsFileFrom(parts: NormalizedPath): boolean {
  return /(^|\/)docs?\//.test(parts.norm) || DOCS_EXTENSIONS.has(parts.ext);
}

function isDependencyManifestFileFrom(parts: NormalizedPath): boolean {
  return DEPENDENCY_MANIFEST_NAMES.has(parts.base);
}

function isConfigFileFrom(parts: NormalizedPath): boolean {
  const { norm, base } = parts;
  if (CONFIG_FILE_NAMES.has(base)) return true;
  if (CONFIG_FILE_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  if (/(^|\/)\.github\/workflows\/[^/]+\.(ya?ml)$/.test(norm)) return true;
  if (/(^|\/)\.circleci\/config\.ya?ml$/.test(norm)) return true;
  if (/\.(config|rc)\.[a-z0-9]+$/i.test(base)) return true;
  // `.stylelintrc`-style: dot-prefixed name with no extension after "rc"; `custom.rc`: dotted rc extension.
  return base.endsWith(".rc") || /^\.[^.]+rc$/i.test(base);
}

const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "go.work.sum",
  "uv.lock",
  "packages.lock.json",
  "flake.lock",
  "deno.lock",
  "pubspec.lock",
  "podfile.lock",
  "mix.lock",
  "package.resolved",
  "gradle.lockfile",
  "pdm.lock",
  "conan.lock",
  "pixi.lock",
  // More ecosystems' resolved-dependency lockfiles, siblings to the above: a
  // committed lockfile is generated, not hand-authored contributor effort.
  "cartfile.resolved", // Carthage (Swift/Obj-C)
  "gopkg.lock", // dep (legacy Go)
  "shard.lock", // Shards (Crystal)
  "rebar.lock", // rebar3 (Erlang)
  "renv.lock", // renv (R)
  "chart.lock", // Helm charts
]);

const DEPENDENCY_MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "requirements.txt",
  "pyproject.toml",
  "pipfile",
  "gemfile",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "deno.json",
  "deno.jsonc",
  "pubspec.yaml",
  "mix.exs",
  "go.work",
  // Swift Package Manager + CocoaPods manifests. Their lockfiles
  // (package.resolved, podfile.lock) are already recognized above, so the
  // manifests they resolve belong in the same dependency-manifest category.
  "package.swift",
  "podfile",
  // Conan (C/C++) manifests — conan.lock is already recognized above, so the
  // manifests it resolves belong here for the same reason as the Swift/CocoaPods
  // pair. Conan accepts either the classic .txt or the Python-based recipe.
  "conanfile.txt",
  "conanfile.py",
  // sbt (Scala/JVM) build definition — the JVM ecosystem is already represented
  // by build.gradle(.kts) and pom.xml; build.sbt is sbt's dependency manifest.
  "build.sbt",
  // setuptools (Python) manifests — the Python ecosystem is already represented
  // by requirements.txt/pyproject.toml/pipfile; setup.py/setup.cfg are the
  // classic setuptools packaging manifests.
  "setup.py",
  "setup.cfg",
  // Crystal (shards) + Erlang (rebar3) manifests — their lockfiles (shard.lock,
  // rebar.lock) are already recognized above, so the manifests they resolve
  // belong here for the same reason as the Conan/Swift/CocoaPods pairs.
  "shard.yml",
  "rebar.config",
  // Further well-known dependency manifests for ecosystems not yet represented.
  "elm.json", // Elm
  "deps.edn", // Clojure (tools.deps)
  "project.clj", // Clojure (Leiningen)
  "environment.yml", // conda
]);

const DOCS_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "markdown", "rst", "adoc", "asciidoc"]);

// Exact basenames (lowercased) that are unambiguously build/CI config files regardless of directory.
const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  "dockerfile",
  "makefile",
  ".editorconfig",
  ".nvmrc",
  ".node-version",
  ".npmrc",
  ".python-version",
  ".ruby-version",
  ".browserslistrc",
  // Monorepo / task-runner config (Turborepo, Nx, Lerna).
  "turbo.json",
  "nx.json",
  "lerna.json",
  "pnpm-workspace.yaml",
  // Linter / formatter config that does not follow the `.eslintrc` / `*.config.*` shapes (Biome).
  "biome.json",
  "biome.jsonc",
  // VCS and build ignore/attribute config (siblings to the existing Dockerfile entry).
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  // Further tool ignore-files, siblings to .gitignore/.dockerignore above. (The
  // .eslintignore/.prettierignore variants are already covered by the .eslint/
  // .prettier prefixes.)
  ".npmignore",
  ".stylelintignore",
  ".vercelignore",
  ".helmignore",
  ".gcloudignore",
  // Dependency automation and local toolchain version pins.
  "renovate.json",
  "dependabot.yml",
  ".tool-versions",
  "mise.toml",
  "lefthook.yml",
  "lefthook.yaml",
  ".pre-commit-config.yaml",
  ".gitleaks.toml",
  // Coverage service config.
  ".codecov.yml",
  ".codecov.yaml",
  "codecov.yml",
  "codecov.yaml",
  // Task-runner config.
  "taskfile.yml",
  "taskfile.yaml",
  "justfile",
  // Docker Compose deploy config.
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
  "compose.override.yml",
  "compose.override.yaml",
  // Hosted deploy config.
  "caddyfile",
  "netlify.toml",
  "vercel.json",
  "railway.json",
  "render.yaml",
  "fly.toml",
  "skaffold.yaml",
  "earthfile",
  "procfile",
  // Hosted CI pipeline definitions (single-file basenames).
  ".gitlab-ci.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "buf.yaml",
  "buf.gen.yaml",
  // Native/C++ build system definitions (siblings to Makefile/Dockerfile above).
  "cmakelists.txt",
  "meson.build",
  "build.bazel",
  "module.bazel",
]);

// Filename prefixes that identify build, lint, test-runner, and environment config files.
const CONFIG_FILE_PREFIXES: readonly string[] = [
  "tsconfig",
  "jsconfig",
  "jest.config",
  "vitest.config",
  "vite.config",
  "webpack.config",
  "rollup.config",
  "postcss.config",
  "tailwind.config",
  "next.config",
  ".env",
  ".eslint",
  ".prettier",
  ".babel",
  // Cloudflare Workers deploy config (`wrangler.toml`, `wrangler.jsonc`, `wrangler.vitest.jsonc`).
  // The trailing dot keeps unrelated names like `wranglers-guide.md` from matching.
  "wrangler.",
];

/** Machine-generated output (codegen, protobuf, source maps, typegen). */
export function isGeneratedFile(path: string): boolean {
  return isGeneratedFileFrom(normalizeForMatch(path));
}

/** Third-party / imported code that lives in the repo but is not the contributor's work. */
export function isVendoredFile(path: string): boolean {
  return isVendoredFileFrom(normalizeForMatch(path));
}

/** Dependency lockfiles (resolved trees), e.g. `package-lock.json`, `go.sum`, `Cargo.lock`. */
export function isLockfile(path: string): boolean {
  return isLockfileFrom(normalizeForMatch(path));
}

/** Minified bundles, e.g. `app.min.js`, `styles.min.css`. */
export function isMinifiedFile(path: string): boolean {
  return isMinifiedFileFrom(normalizeForMatch(path));
}

/** Documentation files (by extension or a top-level `docs/` directory). */
export function isDocsFile(path: string): boolean {
  return isDocsFileFrom(normalizeForMatch(path));
}

/** Dependency manifests (declare dependencies), e.g. `package.json`, `go.mod`, `pyproject.toml`. */
export function isDependencyManifestFile(path: string): boolean {
  return isDependencyManifestFileFrom(normalizeForMatch(path));
}

/**
 * Build, lint, test-runner, monorepo, deploy, and environment configuration files. Distinct from
 * dependency manifests (which declare external dependencies) and source code. Config-only diffs are
 * lower-effort than genuine source changes, so slop signals can weight them differently (#561).
 */
export function isConfigFile(path: string): boolean {
  return isConfigFileFrom(normalizeForMatch(path));
}

/**
 * Files that masquerade as substantive source/work but are machine-produced or imported — the set a
 * padded diff inflates its size with. Lockfiles, dependency manifests, and docs are legitimate change
 * categories and are deliberately excluded here (they have their own matchers for reuse).
 */
export function isNonSubstantivePaddingFile(path: string): boolean {
  return isMinifiedFile(path) || isGeneratedFile(path) || isVendoredFile(path);
}

export type ChangedFileCategory =
  | "minified"
  | "generated"
  | "vendored"
  | "lockfile"
  | "dependency_manifest"
  | "config"
  | "test"
  | "docs"
  | "source"
  | "other";

/**
 * Classify a changed file into a single category. Non-substantive padding categories
 * (minified/generated/vendored) take precedence so they are never miscounted as substantive source
 * or test effort; lockfiles and dependency manifests are recognized before generic docs/source.
 * Normalises the path once and threads the pre-computed parts through every `isX` matcher.
 */
export function classifyChangedFile(path: string): ChangedFileCategory {
  const parts = normalizeForMatch(path);
  if (isMinifiedFileFrom(parts)) return "minified";
  if (isGeneratedFileFrom(parts)) return "generated";
  if (isVendoredFileFrom(parts)) return "vendored";
  if (isLockfileFrom(parts)) return "lockfile";
  if (isDependencyManifestFileFrom(parts)) return "dependency_manifest";
  if (isConfigFileFrom(parts)) return "config";
  if (isTestFile(path) || isTestPath(path)) return "test";
  if (isDocsFileFrom(parts)) return "docs";
  if (isCodeFile(path)) return "source";
  return "other";
}
