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
    const dependencies = (pkg?.dependencies ?? {});
    const devDependencies = (pkg?.devDependencies ?? {});
    const deps = { ...dependencies, ...devDependencies };
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
const DETECTORS = Object.freeze([
    detectNode,
    detectPython,
    detectRust,
    detectGo,
    detectMaven,
    detectGradle,
]);
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
            return { detected: true, ...detected };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2stZGV0ZWN0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhY2stZGV0ZWN0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7NEdBTTRHO0FBQzVHLE9BQU8sRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUF3Q2pDO3dGQUN3RjtBQUN4RixNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBc0IsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNuRSxjQUFjO0lBQ2QsZ0JBQWdCO0lBQ2hCLFVBQVU7SUFDVixXQUFXO0lBQ1gsa0JBQWtCO0lBQ2xCLFNBQVM7SUFDVCxZQUFZO0lBQ1osUUFBUTtJQUNSLFNBQVM7SUFDVCxjQUFjO0lBQ2Qsa0JBQWtCO0NBQ25CLENBQUMsQ0FBQztBQUVILE1BQU0sa0JBQWtCLEdBQ3RCLGtKQUFrSixDQUFDO0FBRXJKLE1BQU0scUJBQXFCLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDNUUsTUFBTSxjQUFjLEdBQWdDLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDaEUsQ0FBQyxnQkFBZ0IsRUFBRSxNQUFNLENBQUM7SUFDMUIsQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDO0lBQ3JCLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQztJQUNwQixDQUFDLG1CQUFtQixFQUFFLEtBQUssQ0FBQztDQUM3QixDQUFDLENBQUM7QUFFSDs2RkFDNkY7QUFDN0YsU0FBUyxVQUFVLENBQUMsUUFBZ0IsRUFBRSxPQUErQjtJQUNuRSxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsVUFBVSxJQUFJLFVBQVUsQ0FBQztJQUNwRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsWUFBWSxJQUFJLFlBQVksQ0FBQztJQUN0RCxNQUFNLE1BQU0sR0FBRyxDQUFDLFlBQW9CLEVBQVcsRUFBRTtRQUMvQyxJQUFJLENBQUM7WUFDSCxPQUFPLFVBQVUsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLFlBQVksQ0FBQyxDQUFDLEtBQUssSUFBSSxDQUFDO1FBQzNELENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUCxPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDLENBQUM7SUFDRixNQUFNLElBQUksR0FBRyxDQUFDLFlBQW9CLEVBQWlCLEVBQUU7UUFDbkQsSUFBSSxDQUFDO1lBQ0gsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUM7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDdkMsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsWUFBWSxDQUFDLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDL0QsT0FBTyxPQUFPLE9BQU8sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ3RELENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUCxPQUFPLElBQUksQ0FBQztRQUNkLENBQUM7SUFDSCxDQUFDLENBQUM7SUFDRixPQUFPLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxDQUFDO0FBQzFCLENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxJQUFtQjtJQUNwQyxJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMxQyxJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBWSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pDLE9BQU8sTUFBTSxJQUFJLE9BQU8sTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUUsTUFBa0MsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQzNGLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7QUFDSCxDQUFDO0FBRUQsK0dBQStHO0FBQy9HLFNBQVMsVUFBVSxDQUFDLE9BQWdDLEVBQUUsU0FBaUIsRUFBRSxPQUFlO0lBQ3RGLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxPQUFPLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxRQUFRLENBQUMsQ0FBQztJQUN2RixJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDaEQsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDO0FBQzFELENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxNQUF3QjtJQUM1QyxNQUFNLEtBQUssR0FBRyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7SUFDNUQsT0FBTyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQW1DLEVBQUUsUUFBdUI7SUFDdEYsTUFBTSxRQUFRLEdBQ1osT0FBTyxHQUFHLEVBQUUsY0FBYyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFFLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUN4RyxJQUFJLHFCQUFxQixDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUM7UUFBRSxPQUFPLFFBQVEsQ0FBQztJQUM5RCxNQUFNLE1BQU0sR0FBRyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDO0lBQ2xFLCtHQUErRztJQUMvRyxPQUFPLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsdUJBQXVCLENBQUMsR0FBbUM7SUFDbEUsTUFBTSxZQUFZLEdBQUcsQ0FBQyxHQUFHLEVBQUUsWUFBWSxJQUFJLEVBQUUsQ0FBNEIsQ0FBQztJQUMxRSxNQUFNLGVBQWUsR0FBRyxDQUFDLEdBQUcsRUFBRSxlQUFlLElBQUksRUFBRSxDQUE0QixDQUFDO0lBQ2hGLE1BQU0sSUFBSSxHQUFHLEVBQUUsR0FBRyxZQUFZLEVBQUUsR0FBRyxlQUFlLEVBQUUsQ0FBQztJQUNyRCxPQUFPLE9BQU8sSUFBSSxDQUFDLFVBQVUsS0FBSyxRQUFRLENBQUM7QUFDN0MsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBVTtJQUMxQyxJQUFJLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3pDLE1BQU0sR0FBRyxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztJQUM1QyxNQUFNLE9BQU8sR0FDWCxHQUFHLElBQUksT0FBTyxHQUFHLENBQUMsT0FBTyxLQUFLLFFBQVEsSUFBSSxHQUFHLENBQUMsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFFLEdBQUcsQ0FBQyxPQUFtQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDdkksTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLGVBQWUsQ0FBQyxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQztJQUN2RyxNQUFNLFFBQVEsR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdEMsTUFBTSxjQUFjLEdBQUcsa0JBQWtCLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBRXpELE1BQU0sU0FBUyxHQUFHLFVBQVUsQ0FBQyxPQUFPLEVBQUUsT0FBTyxFQUFFLCtCQUErQixDQUFDLENBQUM7SUFDaEYsTUFBTSxRQUFRLEdBQUcsVUFBVSxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztJQUNoRSxNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO0lBQ2hFLE1BQU0sVUFBVSxHQUFHLFVBQVUsQ0FBQyxPQUFPLEVBQUUsUUFBUSxFQUFFLHlCQUF5QixDQUFDLENBQUM7SUFFNUUsT0FBTztRQUNMLFFBQVE7UUFDUixjQUFjO1FBQ2QsWUFBWSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsR0FBRyxjQUFjLFFBQVEsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDckUsdUdBQXVHO1FBQ3ZHLFdBQVcsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxjQUFjLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxjQUFjLFFBQVEsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUNySCxXQUFXLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLGNBQWMsUUFBUSxRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUNsRSxhQUFhLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxHQUFHLGNBQWMsUUFBUSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUN4RSxRQUFRLEVBQUUsRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLFFBQVEsRUFBRTtLQUNqRCxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBVTtJQUM1QyxNQUFNLFFBQVEsR0FBRyxDQUFDLGdCQUFnQixFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsa0JBQWtCLEVBQUUsU0FBUyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3pHLElBQUksUUFBUSxLQUFLLFNBQVM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN4QyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLENBQUM7SUFFL0MsSUFBSSxjQUFzQixDQUFDO0lBQzNCLElBQUksUUFBUSxHQUFrQixJQUFJLENBQUM7SUFDbkMsSUFBSSxNQUFNLENBQUMsYUFBYSxDQUFDLElBQUksa0JBQWtCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7UUFDaEUsY0FBYyxHQUFHLFFBQVEsQ0FBQztRQUMxQixRQUFRLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMxRCxDQUFDO1NBQU0sSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUM3QixjQUFjLEdBQUcsSUFBSSxDQUFDO1FBQ3RCLFFBQVEsR0FBRyxTQUFTLENBQUM7SUFDdkIsQ0FBQztTQUFNLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxjQUFjLENBQUMsRUFBRSxDQUFDO1FBQ3ZELGNBQWMsR0FBRyxRQUFRLENBQUM7UUFDMUIsUUFBUSxHQUFHLE1BQU0sQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDNUQsQ0FBQztTQUFNLENBQUM7UUFDTixjQUFjLEdBQUcsS0FBSyxDQUFDO0lBQ3pCLENBQUM7SUFFRCw4R0FBOEc7SUFDOUcsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLFdBQVcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDaEcsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsSUFBSSxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFFbEcsT0FBTztRQUNMLFFBQVEsRUFBRSxRQUFRO1FBQ2xCLGNBQWM7UUFDZCxZQUFZLEVBQUUsa0JBQWtCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUM1SCxXQUFXLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDeEMsV0FBVyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxJQUFJO1FBQzVDLGFBQWEsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUMvQyxRQUFRLEVBQUUsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFO0tBQ2pDLENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxVQUFVLENBQUMsRUFBRSxNQUFNLEVBQVU7SUFDcEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN2QyxPQUFPO1FBQ0wsUUFBUSxFQUFFLE1BQU07UUFDaEIsY0FBYyxFQUFFLE9BQU87UUFDdkIsWUFBWSxFQUFFLGFBQWE7UUFDM0IsV0FBVyxFQUFFLFlBQVk7UUFDekIsV0FBVyxFQUFFLGNBQWM7UUFDM0IsYUFBYSxFQUFFLFdBQVc7UUFDMUIsUUFBUSxFQUFFLEVBQUUsUUFBUSxFQUFFLFlBQVksRUFBRSxRQUFRLEVBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRTtLQUMzRixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEVBQUUsTUFBTSxFQUFVO0lBQ2xDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDbkMsTUFBTSxXQUFXLEdBQUcsTUFBTSxDQUFDLGVBQWUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3BHLE9BQU87UUFDTCxRQUFRLEVBQUUsSUFBSTtRQUNkLGNBQWMsRUFBRSxJQUFJO1FBQ3BCLFlBQVksRUFBRSxnQkFBZ0I7UUFDOUIsV0FBVyxFQUFFLGVBQWU7UUFDNUIsV0FBVyxFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxDQUFDLGNBQWM7UUFDL0QsYUFBYSxFQUFFLFlBQVk7UUFDM0IsUUFBUSxFQUFFLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRTtLQUMvRSxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLEVBQUUsTUFBTSxFQUFVO0lBQ3JDLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDcEMsT0FBTztRQUNMLFFBQVEsRUFBRSxNQUFNO1FBQ2hCLGNBQWMsRUFBRSxPQUFPO1FBQ3ZCLFlBQVksRUFBRSxnQkFBZ0I7UUFDOUIsV0FBVyxFQUFFLGFBQWE7UUFDMUIsV0FBVyxFQUFFLElBQUk7UUFDakIsYUFBYSxFQUFFLElBQUk7UUFDbkIsUUFBUSxFQUFFLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ2xELENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsRUFBRSxNQUFNLEVBQVU7SUFDdEMsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ2xILElBQUksUUFBUSxLQUFLLElBQUk7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNuQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0lBQzFELE9BQU87UUFDTCxRQUFRLEVBQUUsTUFBTTtRQUNoQixjQUFjLEVBQUUsUUFBUTtRQUN4QixZQUFZLEVBQUUsR0FBRyxNQUFNLFFBQVE7UUFDL0IsV0FBVyxFQUFFLEdBQUcsTUFBTSxPQUFPO1FBQzdCLFdBQVcsRUFBRSxJQUFJO1FBQ2pCLGFBQWEsRUFBRSxJQUFJO1FBQ25CLFFBQVEsRUFBRSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFO0tBQ3ZDLENBQUM7QUFDSixDQUFDO0FBRUQsTUFBTSxTQUFTLEdBQWdFLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDM0YsVUFBVTtJQUNWLFlBQVk7SUFDWixVQUFVO0lBQ1YsUUFBUTtJQUNSLFdBQVc7SUFDWCxZQUFZO0NBQ2IsQ0FBQyxDQUFDO0FBRUg7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsUUFBZ0IsRUFBRSxVQUFrQyxFQUFFO0lBQ3BGLElBQUksT0FBTyxRQUFRLEtBQUssUUFBUSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxFQUFFLENBQUM7UUFDckQsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLG9EQUFvRCxFQUFFLENBQUM7SUFDM0YsQ0FBQztJQUNELE1BQU0sTUFBTSxHQUFHLFVBQVUsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDN0MsS0FBSyxNQUFNLFFBQVEsSUFBSSxTQUFTLEVBQUUsQ0FBQztRQUNqQyxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbEMsSUFBSSxRQUFRLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDdEIsT0FBTyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsR0FBRyxRQUFRLEVBQUUsQ0FBQztRQUN6QyxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxrQkFBa0IsRUFBRSxDQUFDO0FBQ3pELENBQUM7QUFFRCwyR0FBMkc7QUFDM0csTUFBTSxVQUFVLGtCQUFrQixDQUFDLEtBQXlDO0lBQzFFLElBQUksQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLFFBQVEsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUN0QyxPQUFPLHVCQUF1QixLQUFLLEVBQUUsTUFBTSxJQUFJLGdCQUFnQixFQUFFLENBQUM7SUFDcEUsQ0FBQztJQUNELE1BQU0sUUFBUSxHQUFHO1FBQ2YsS0FBSyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsV0FBVyxLQUFLLENBQUMsWUFBWSxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDN0QsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsVUFBVSxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDMUQsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsVUFBVSxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUk7UUFDMUQsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsWUFBWSxLQUFLLENBQUMsYUFBYSxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUk7S0FDakUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQW1CLEVBQUUsQ0FBQyxLQUFLLEtBQUssSUFBSSxDQUFDLENBQUM7SUFDckQsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxvQ0FBb0MsQ0FBQztJQUN4RyxPQUFPLEdBQUcsS0FBSyxDQUFDLFFBQVEsUUFBUSxLQUFLLENBQUMsY0FBYyxJQUFJLFNBQVMsR0FBRyxNQUFNLEVBQUUsQ0FBQztBQUMvRSxDQUFDIn0=