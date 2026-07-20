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
export declare const RECOGNIZED_MANIFESTS: readonly string[];
/**
 * Detect the stack of an already-cloned repository at `repoPath`. Returns `{ detected: true, ... }` with the
 * language, package manager, and any confidently-inferred commands, or `{ detected: false, reason }` when no
 * recognized manifest is present. Never throws.
 */
export declare function detectRepoStack(repoPath: string, options?: DetectRepoStackOptions): RepoStackResult;
/** One-line human summary of a detection result, suitable for a coding-agent prompt or an operator log. */
export declare function renderStackSummary(stack: RepoStackResult): string;
