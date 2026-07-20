/** Stack auto-detection (#4785): inspect an already-cloned target repo's manifest / lockfile / config files and
 * infer a structured description of its stack — language, package manager, and the build / test / lint / format
 * commands — before any code-generation step runs. Like `miner-goal-spec.js` this reads the ALREADY-CLONED repo on
 * disk (attempt-worktree.js's prepareAttemptWorktree runs first), so the injected `existsSync` / `readFileSync`
 * always receive the FULL joined path, mirroring node:fs. It is pure and NEVER throws: an unreadable/unparseable
 * file degrades to "no evidence" rather than crashing, and — per the acceptance criteria — a repo whose stack
 * can't be confidently identified returns an explicit `{ detected: false, reason }` instead of guessing. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
const NO_MANIFEST_REASON = "No recognized dependency manifest (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, or build.gradle) was found at the repository root.";
const NODE_PACKAGE_MANAGERS = Object.freeze(["npm", "yarn", "pnpm", "bun"]);
const NODE_LOCKFILES = Object.freeze([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
]);
/** Build a never-throwing accessor over the cloned repo. `exists` and `read` both swallow fs errors so the detector
 * treats an EACCES/ENOENT/binary file as simply "absent" instead of crashing the attempt. */
function makeAccess(repoPath, options) {
    const existsImpl = options.existsSync ?? existsSync;
    const readImpl = options.readFileSync ?? readFileSync;
    const exists = (relativePath) => {
        try {
            return existsImpl(join(repoPath, relativePath)) === true;
        }
        catch {
            return false;
        }
    };
    const read = (relativePath) => {
        try {
            if (!exists(relativePath))
                return null;
            const content = readImpl(join(repoPath, relativePath), "utf8");
            return typeof content === "string" ? content : null;
        }
        catch {
            return null;
        }
    };
    return { exists, read };
}
function parseJson(text) {
    if (typeof text !== "string")
        return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Pick a package.json script by exact name first, then by pattern, considering only string-valued scripts. */
function pickScript(scripts, exactName, pattern) {
    const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");
    if (names.includes(exactName))
        return exactName;
    return names.find((name) => pattern.test(name)) ?? null;
}
function nodeLockfile(exists) {
    const match = NODE_LOCKFILES.find(([file]) => exists(file));
    return match ? match[0] : null;
}
function nodePackageManager(pkg, lockfile) {
    const corepack = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0].trim().toLowerCase() : "";
    if (NODE_PACKAGE_MANAGERS.includes(corepack))
        return corepack;
    const byLock = NODE_LOCKFILES.find(([file]) => file === lockfile);
    // A package.json with no lockfile is still a Node project; npm is its default runner (a default, not a guess).
    return byLock ? byLock[1] : "npm";
}
function hasTypescriptDependency(pkg) {
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    return typeof deps.typescript === "string";
}
function detectNode({ exists, read }) {
    if (!exists("package.json"))
        return null;
    const pkg = parseJson(read("package.json"));
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
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
function detectPython({ exists, read }) {
    const manifest = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"].find(exists);
    if (manifest === undefined)
        return null;
    const pyproject = read("pyproject.toml") ?? "";
    let packageManager;
    let lockfile = null;
    if (exists("poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) {
        packageManager = "poetry";
        lockfile = exists("poetry.lock") ? "poetry.lock" : null;
    }
    else if (exists("uv.lock")) {
        packageManager = "uv";
        lockfile = "uv.lock";
    }
    else if (exists("Pipfile") || exists("Pipfile.lock")) {
        packageManager = "pipenv";
        lockfile = exists("Pipfile.lock") ? "Pipfile.lock" : null;
    }
    else {
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
function detectRust({ exists }) {
    if (!exists("Cargo.toml"))
        return null;
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
function detectGo({ exists }) {
    if (!exists("go.mod"))
        return null;
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
function detectMaven({ exists }) {
    if (!exists("pom.xml"))
        return null;
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
function detectGradle({ exists }) {
    const manifest = exists("build.gradle") ? "build.gradle" : exists("build.gradle.kts") ? "build.gradle.kts" : null;
    if (manifest === null)
        return null;
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
export function detectRepoStack(repoPath, options = {}) {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
        return { detected: false, reason: "A repository path is required to detect the stack." };
    }
    const access = makeAccess(repoPath, options);
    for (const detector of DETECTORS) {
        const detected = detector(access);
        if (detected !== null) {
            // Detectors may leave lockfile undefined; DetectedRepoStack wants string | null (pre-existing shape).
            return { detected: true, ...detected, evidence: { ...detected.evidence, lockfile: detected.evidence.lockfile ?? null } };
        }
    }
    return { detected: false, reason: NO_MANIFEST_REASON };
}
/** One-line human summary of a detection result, suitable for a coding-agent prompt or an operator log. */
export function renderStackSummary(stack) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2stZGV0ZWN0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhY2stZGV0ZWN0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7NEdBTTRHO0FBQzVHLE9BQU8sRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFpQ2pDO3dGQUN3RjtBQUN4RixNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ2hELGNBQWM7SUFDZCxnQkFBZ0I7SUFDaEIsVUFBVTtJQUNWLFdBQVc7SUFDWCxrQkFBa0I7SUFDbEIsU0FBUztJQUNULFlBQVk7SUFDWixRQUFRO0lBQ1IsU0FBUztJQUNULGNBQWM7SUFDZCxrQkFBa0I7Q0FDbkIsQ0FBQyxDQUFDO0FBRUgsTUFBTSxrQkFBa0IsR0FDdEIsa0pBQWtKLENBQUM7QUFFckosTUFBTSxxQkFBcUIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUM1RSxNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ25DLENBQUMsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDO0lBQzFCLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQztJQUNyQixDQUFDLFdBQVcsRUFBRSxLQUFLLENBQUM7SUFDcEIsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLENBQUM7Q0FDN0IsQ0FBQyxDQUFDO0FBRUg7NkZBQzZGO0FBQzdGLFNBQVMsVUFBVSxDQUFDLFFBQWEsRUFBRSxPQUFZO0lBQzdDLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDO0lBQ3BELE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxZQUFZLElBQUksWUFBWSxDQUFDO0lBQ3RELE1B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