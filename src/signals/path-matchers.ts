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
  "uv.lock",
  "packages.lock.json",
  "flake.lock",
  "deno.lock",
  "pubspec.lock",
  "podfile.lock",
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
]);

const DOCS_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "markdown", "rst", "adoc", "asciidoc"]);

// Exact basenames (lowercased) that are unambiguously build/CI config files regardless of directory.
const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  "dockerfile",
  "makefile",
  ".editorconfig",
  ".nvmrc",
  ".npmrc",
  ".browserslistrc",
  // Monorepo / task-runner config (Turborepo, Nx, Lerna).
  "turbo.json",
  "nx.json",
  "lerna.json",
  // Linter / formatter config that does not follow the `.eslintrc` / `*.config.*` shapes (Biome).
  "biome.json",
  "biome.jsonc",
  // VCS and build ignore/attribute config (siblings to the existing Dockerfile entry).
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
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
  // Hosted CI pipeline definitions (single-file basenames).
  ".gitlab-ci.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "buf.yaml",
  "buf.gen.yaml",
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
  const norm = normalize(path);
  return (
    /(^|\/)(__generated__|generated)\//.test(norm) ||
    /\.(generated|gen)\.[^/]+$/.test(norm) ||
    /\.pb\.(go|ts|js)$/.test(norm) ||
    /_pb2\.pyi?$/.test(norm) ||
    /\.g\.dart$/.test(norm) ||
    /\.(js|jsx|ts|tsx|css)\.map$/.test(norm) ||
    basename(norm) === "worker-configuration.d.ts"
  );
}

/** Third-party / imported code that lives in the repo but is not the contributor's work. */
export function isVendoredFile(path: string): boolean {
  return /(^|\/)(vendor|vendored|third_party|third-party|node_modules)\//.test(normalize(path));
}

/** Dependency lockfiles (resolved trees), e.g. `package-lock.json`, `go.sum`, `Cargo.lock`. */
export function isLockfile(path: string): boolean {
  return LOCKFILE_NAMES.has(basename(path));
}

/** Minified bundles, e.g. `app.min.js`, `styles.min.css`. */
export function isMinifiedFile(path: string): boolean {
  return /\.min\.[a-z0-9]+$/.test(normalize(path));
}

/** Documentation files (by extension or a top-level `docs/` directory). */
export function isDocsFile(path: string): boolean {
  const norm = normalize(path);
  return /(^|\/)docs?\//.test(norm) || DOCS_EXTENSIONS.has(extension(norm));
}

/** Dependency manifests (declare dependencies), e.g. `package.json`, `go.mod`, `pyproject.toml`. */
export function isDependencyManifestFile(path: string): boolean {
  return DEPENDENCY_MANIFEST_NAMES.has(basename(path));
}

/**
 * Build, lint, test-runner, monorepo, deploy, and environment configuration files. Distinct from
 * dependency manifests (which declare external dependencies) and source code. Config-only diffs are
 * lower-effort than genuine source changes, so slop signals can weight them differently (#561).
 */
export function isConfigFile(path: string): boolean {
  const norm = normalize(path);
  const base = basename(path);
  if (CONFIG_FILE_NAMES.has(base)) return true;
  if (CONFIG_FILE_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  if (/(^|\/)\.github\/workflows\/[^/]+\.(ya?ml)$/.test(norm)) return true;
  if (/(^|\/)\.circleci\/config\.ya?ml$/.test(norm)) return true;
  if (/\.(config|rc)\.[a-z0-9]+$/i.test(base)) return true;
  // `.stylelintrc`-style: dot-prefixed name with no extension after "rc"; `custom.rc`: dotted rc extension.
  return base.endsWith(".rc") || /^\.[^.]+rc$/i.test(base);
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
 */
export function classifyChangedFile(path: string): ChangedFileCategory {
  if (isMinifiedFile(path)) return "minified";
  if (isGeneratedFile(path)) return "generated";
  if (isVendoredFile(path)) return "vendored";
  if (isLockfile(path)) return "lockfile";
  if (isDependencyManifestFile(path)) return "dependency_manifest";
  if (isConfigFile(path)) return "config";
  if (isTestFile(path) || isTestPath(path)) return "test";
  if (isDocsFile(path)) return "docs";
  if (isCodeFile(path)) return "source";
  return "other";
}
