/** Stack auto-detection (#4785): inspect an already-cloned target repo's manifest / lockfile / config files and
 * infer a structured description of its stack — language, package manager, and the build / test / lint / format
 * commands — before any code-generation step runs. Like `miner-goal-spec.js` this reads the ALREADY-CLONED repo on
 * disk (attempt-worktree.js's prepareAttemptWorktree runs first), so the injected `existsSync` / `readFileSync`
 * always receive the FULL joined path, mirroring node:fs. It is pure and NEVER throws: an unreadable/unparseable
 * file degrades to "no evidence" rather than crashing, and — per the acceptance criteria — a repo whose stack
 * can't be confidently identified returns an explicit `{ detected: false, reason }` instead of guessing. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Which manifest (and lockfile, when present) drove the detection. */
export type StackEvidence = {
  manifest: string;
  lockfile: string | null;
};

/** A confidently-detected stack. Command fields are `null` when the command can't be inferred without guessing. */
export type DetectedRepoStack = {
  detected: true;
  language: string;
  packageManager: string | null;
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  formatCommand: string | null;
  evidence: StackEvidence;
};

/** A repo whose stack could not be confidently identified. */
export type UndetectedRepoStack = {
  detected: false;
  reason: string;
};

export type RepoStackResult = DetectedRepoStack | UndetectedRepoStack;

export type DetectRepoStackOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
};

/** Manifests, in the precedence order detection tries them; the first matching primary manifest wins. A caller with
 * a known polyglot repo can inspect `evidence.manifest` to see which one was chosen. */
export const RECOGNIZED_MANIFESTS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const NO_MANIFEST_REASON =
  "No recognized dependency manifest (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, or build.gradle) was found at the repository root.";

const NODE_PACKAGE_MANAGERS = Object.freeze(["npm", "yarn", "pnpm", "bun"]);
const NODE_LOCKFILES = Object.freeze([
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
]);

/** Build a never-throwing accessor over the cloned repo. `exists` and `read` both swallow fs errors so the detector
 * treats an EACCES/ENOENT/binary file as simply "absent" instead of crashing the attempt. */
function makeAccess(repoPath: any, options: any) {
  const existsImpl = options.existsSync ?? existsSync;
  const readImpl = options.readFileSync ?? readFileSync;
  const exists = (relativePath: string) => {
    try {
      return existsImpl(join(repoPath, relativePath)) === true;
    } catch {
      return false;
    }
  };
  const read = (relativePath: string) => {
    try {
      if (!exists(relativePath)) return null;
      const content = readImpl(join(repoPath, relativePath), "utf8");
      return typeof content === "string" ? content : null;
    } catch {
      return null;
    }
  };
  return { exists, read };
}

function parseJson(text: any) {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Pick a package.json script by exact name first, then by pattern, considering only string-valued scripts. */
function pickScript(scripts: any, exactName: any, pattern: any) {
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");
  if (names.includes(exactName)) return exactName;
  return names.find((name) => pattern.test(name)) ?? null;
}

function nodeLockfile(exists: any) {
  const match = NODE_LOCKFILES.find(([file]) => exists(file));
  return match ? match[0] : null;
}

function nodePackageManager(pkg: any, lockfile: any) {
  const corepack =
    typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0].trim().toLowerCase() : "";
  if (NODE_PACKAGE_MANAGERS.includes(corepack)) return corepack;
  const byLock = NODE_LOCKFILES.find(([file]) => file === lockfile);
  // A package.json with no lockfile is still a Node project; npm is its default runner (a default, not a guess).
  return byLock ? byLock[1] : "npm";
}

function hasTypescriptDependency(pkg: any) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return typeof deps.typescript === "string";
}

function detectNode({ exists, read }: any) {
  if (!exists("package.json")) return null;
  const pkg = parseJson(read("package.json"));
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  const language = exists("tsconfig.json") || hasTypescriptDependency(pkg) ? "typescript" : "javascript";
  const lockfile = nodeLockfile(exists);
  const packageManager = nodePackageManager(pkg, lockfile);

  const buildName = pickScript(scripts, "build", /^(build|compile|bundle)(:|$)/i);
  const testName = pickScript(scripts, "test", /(^|:)test(:|$)/i);
  const lintName = pickScript(scripts, "lint", /(^|:)lint(:|$)/i);
  const formatName = pickScript(scripts, "format", /(^|:)(format|fmt)(:|$)/i);

  return {
    language,
    packageManager,
    buildCommand: buildName ? `${packageManager} run ${buildName}` : null,
    // `<pm> test` is the built-in test lifecycle across npm/yarn/pnpm/bun; a non-"test" script uses `run`.
    testCommand: testName ? (testName === "test" ? `${packageManager} test` : `${packageManager} run ${testName}`) : null,
    lintCommand: lintName ? `${packageManager} run ${lintName}` : null,
    formatCommand: formatName ? `${packageManager} run ${formatName}` : null,
    evidence: { manifest: "package.json", lockfile },
  };
}

function detectPython({ exists, read }: any) {
  const manifest = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"].find(exists);
  if (manifest === undefined) return null;
  const pyproject = read("pyproject.toml") ?? "";

  let packageManager;
  let lockfile = null;
  if (exists("poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) {
    packageManager = "poetry";
    lockfile = exists("poetry.lock") ? "poetry.lock" : null;
  } else if (exists("uv.lock")) {
    packageManager = "uv";
    lockfile = "uv.lock";
  } else if (exists("Pipfile") || exists("Pipfile.lock")) {
    packageManager = "pipenv";
    lockfile = exists("Pipfile.lock") ? "Pipfile.lock" : null;
  } else {
    packageManager = "pip";
  }

  // Commands are inferred only from real config so an undeclared tool is never guessed (acceptance: fail safe).
  const hasRuff = exists("ruff.toml") || exists(".ruff.toml") || /\[tool\.ruff\]/.test(pyproject);
  const hasPytest = exists("pytest.ini") || exists("tox.ini") || /\[tool\.pytest\b/.test(pyproject);

  return {
    language: "python",
    packageManager,
    buildCommand: /\[build-system\]/.test(pyproject) ? (packageManager === "poetry" ? "poetry build" : "python -m build") : null,
    testCommand: hasPytest ? "pytest" : null,
    lintCommand: hasRuff ? "ruff check ." : null,
    formatCommand: hasRuff ? "ruff format ." : null,
    evidence: { manifest, lockfile },
  };
}

function detectRust({ exists }: any) {
  if (!exists("Cargo.toml")) return null;
  return {
    language: "rust",
    packageManager: "cargo",
    buildCommand: "cargo build",
    testCommand: "cargo test",
    lintCommand: "cargo clippy",
    formatCommand: "cargo fmt",
    evidence: { manifest: "Cargo.toml", lockfile: exists("Cargo.lock") ? "Cargo.lock" : null },
  };
}

function detectGo({ exists }: any) {
  if (!exists("go.mod")) return null;
  const hasGolangci = exists(".golangci.yml") || exists(".golangci.yaml") || exists(".golangci.toml");
  return {
    language: "go",
    packageManager: "go",
    buildCommand: "go build ./...",
    testCommand: "go test ./...",
    lintCommand: hasGolangci ? "golangci-lint run" : "go vet ./...",
    formatCommand: "gofmt -l .",
    evidence: { manifest: "go.mod", lockfile: exists("go.sum") ? "go.sum" : null },
  };
}

function detectMaven({ exists }: any) {
  if (!exists("pom.xml")) return null;
  return {
    language: "java",
    packageManager: "maven",
    buildCommand: "mvn -B package",
    testCommand: "mvn -B test",
    lintCommand: null,
    formatCommand: null,
    evidence: { manifest: "pom.xml", lockfile: null },
  };
}

function detectGradle({ exists }: any) {
  const manifest = exists("build.gradle") ? "build.gradle" : exists("build.gradle.kts") ? "build.gradle.kts" : null;
  if (manifest === null) return null;
  const runner = exists("gradlew") ? "./gradlew" : "gradle";
  return {
    language: "java",
    packageManager: "gradle",
    buildCommand: `${runner} build`,
    testCommand: `${runner} test`,
    lintCommand: null,
    formatCommand: null,
    evidence: { manifest, lockfile: null },
  };
}

const DETECTORS = Object.freeze([detectNode, detectPython, detectRust, detectGo, detectMaven, detectGradle]);

/**
 * Detect the stack of an already-cloned repository at `repoPath`. Returns `{ detected: true, ... }` with the
 * language, package manager, and any confidently-inferred commands, or `{ detected: false, reason }` when no
 * recognized manifest is present. Never throws.
 */
export function detectRepoStack(repoPath: string, options: DetectRepoStackOptions = {}): RepoStackResult {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    return { detected: false, reason: "A repository path is required to detect the stack." };
  }
  const access = makeAccess(repoPath, options);
  for (const detector of DETECTORS) {
    const detected = detector(access);
    if (detected !== null) {
      // Detectors may leave lockfile undefined; DetectedRepoStack wants string | null (pre-existing shape).
      return { detected: true, ...detected, evidence: { ...detected.evidence, lockfile: detected.evidence.lockfile ?? null } } as DetectedRepoStack;
    }
  }
  return { detected: false, reason: NO_MANIFEST_REASON };
}

/** One-line human summary of a detection result, suitable for a coding-agent prompt or an operator log. */
export function renderStackSummary(stack: RepoStackResult): string {
  if (!stack || stack.detected !== true) {
    return `stack not detected: ${stack?.reason ?? "unknown reason"}`;
  }
  const commands = [
    stack.buildCommand ? `build=\`${stack.buildCommand}\`` : null,
    stack.testCommand ? `test=\`${stack.testCommand}\`` : null,
    stack.lintCommand ? `lint=\`${stack.lintCommand}\`` : null,
    stack.formatCommand ? `format=\`${stack.formatCommand}\`` : null,
  ].filter((entry) => entry !== null);
  const suffix = commands.length > 0 ? ` (${commands.join(", ")})` : " (no validation commands detected)";
  return `${stack.language} via ${stack.packageManager ?? "unknown"}${suffix}`;
}
