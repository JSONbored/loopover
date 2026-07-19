// Docs-accuracy audit for the miner's DEPLOYMENT.md (#5180). Mirrors the self-host docs audit
// (apps/loopover-ui/src/lib/selfhost-docs-audit.ts): parse the deployment doc, then assert every
// LOOPOVER_MINER_* / MINER_* env var, repo-relative file path, and `loopover-miner <subcommand>`
// it documents still exists under packages/loopover-miner/**. A rename or move that leaves the doc
// stale then fails CI with a message naming the exact stale claim, instead of misleading operators.
// Wired into CI via `npm run test:miner-deployment-docs-audit` (scripts/check-miner-deployment-docs.mjs)
// and the live unit suite in test/unit/miner-deployment-docs-audit.test.ts (#6158).
/** The miner's own env-var namespace: LOOPOVER_MINER_* and the shorter MINER_* aliases it reads. */
const ENV_VAR_PATTERN = /\b(?:LOOPOVER_MINER|MINER)_[A-Z0-9_]+\b/g;
/** `loopover-miner <subcommand>` CLI invocations, excluding the `@loopover/miner` package spelling. */
const SUBCOMMAND_PATTERN = /(?<![\w./@-])loopover-miner\s+([a-z][a-z0-9-]*)/g;
/** Markdown inline-link targets: the `target` in `](target)`. */
const MARKDOWN_LINK_PATTERN = /\]\(([^)]+)\)/g;
/** Link targets the audit ignores: URLs, in-page anchors, and runtime-generated (~ or absolute) paths. */
const NON_REPO_LINK_PATTERN = /^(?:https?:\/\/|mailto:|#|~|\/)/;
/** `cliArgs[0] === "<name>"` guards in the miner bin — the CLI's registered top-level command table. */
const CLI_DISPATCH_PATTERN = /cliArgs\[0\]\s*===\s*"([a-z][a-z0-9-]*)"/g;
/** Collect every LOOPOVER_MINER_* / MINER_* token that appears in `text` (doc prose/code or source). */
export function scanEnvVarTokens(text) {
    const tokens = new Set();
    for (const match of text.matchAll(ENV_VAR_PATTERN)) {
        tokens.add(match[0]);
    }
    return tokens;
}
/** Sorted, de-duplicated env-var names DEPLOYMENT.md claims the miner honors. */
export function extractEnvVarClaims(markdown) {
    return [...scanEnvVarTokens(markdown)].sort();
}
/** Sorted, de-duplicated `loopover-miner <subcommand>` subcommands DEPLOYMENT.md documents. */
export function extractSubcommandClaims(markdown) {
    const commands = new Set();
    for (const match of markdown.matchAll(SUBCOMMAND_PATTERN)) {
        commands.add(match[1]);
    }
    return [...commands].sort();
}
/** True when a markdown link target is an on-disk repo path (not a URL, anchor, or runtime path). */
export function isRepoRelativePath(target) {
    return !NON_REPO_LINK_PATTERN.test(target);
}
/** Sorted, de-duplicated repo-relative file paths DEPLOYMENT.md links to (external issue links excluded).
 *  An in-file anchor fragment (`file.md#heading`) is stripped before the path is recorded -- the fragment
 *  names a heading inside the target file, not a filesystem entry, so checking it against `pathExists`
 *  verbatim would always fail even when the linked file (and heading) both genuinely exist. */
export function extractFilePathClaims(markdown) {
    const paths = new Set();
    for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
        const target = match[1].trim();
        if (isRepoRelativePath(target)) {
            const [pathOnly] = target.split("#");
            paths.add(pathOnly);
        }
    }
    return [...paths].sort();
}
/** The set of top-level subcommands the miner CLI dispatches, parsed from its bin entry source. */
export function scanRegisteredCommands(binSource) {
    const commands = new Set();
    for (const match of binSource.matchAll(CLI_DISPATCH_PATTERN)) {
        commands.add(match[1]);
    }
    return commands;
}
/**
 * Cross-check parsed DEPLOYMENT.md claims against reality. `reality` supplies three predicates so this
 * comparison stays pure and filesystem-independent: `hasEnvRead(name)` (a read of that env var exists
 * under packages/loopover-miner/**), `pathExists(relativePath)` (the doc-relative path is on disk),
 * and `isRegisteredCommand(name)` (the subcommand is dispatched by the CLI). Returns the drift findings,
 * each failure naming the specific stale claim rather than a generic mismatch.
 */
export function auditDeploymentDocs(claims, reality) {
    const failures = [];
    for (const name of claims.envVars) {
        if (!reality.hasEnvRead(name)) {
            failures.push(`env var "${name}" is documented in DEPLOYMENT.md but no read of it exists under packages/loopover-miner/**`);
        }
    }
    for (const path of claims.filePaths) {
        if (!reality.pathExists(path)) {
            failures.push(`file path "${path}" is linked from DEPLOYMENT.md but no longer exists on disk`);
        }
    }
    for (const command of claims.subcommands) {
        if (!reality.isRegisteredCommand(command)) {
            failures.push(`CLI subcommand "loopover-miner ${command}" is documented in DEPLOYMENT.md but is not registered in the CLI command table`);
        }
    }
    // Reverse direction (#6601): a real `LOOPOVER_MINER_*` env-var read that DEPLOYMENT.md never documents. Scoped
    // to the `LOOPOVER_MINER_` prefix and excluding the `*_DB` family (documented generically via one pattern
    // sentence, not enumerated) and the bare `MINER_*` alias namespace (which also matches non-env event/metric/
    // filename constants). `reality.envReads` is the enumerable set of real reads the forward `hasEnvRead` probes.
    const documented = new Set(claims.envVars);
    for (const name of reality.envReads) {
        if (name.startsWith("LOOPOVER_MINER_") && !name.endsWith("_DB") && !documented.has(name)) {
            failures.push(`env var "${name}" is read under packages/loopover-miner/** but is not documented in DEPLOYMENT.md`);
        }
    }
    return { ok: failures.length === 0, failures };
}
/** Run the audit and throw a build-failing error naming every stale claim; returns the result when in sync. */
export function assertDeploymentDocsInSync(claims, reality) {
    const result = auditDeploymentDocs(claims, reality);
    if (!result.ok) {
        throw new Error(`DEPLOYMENT.md is out of sync with packages/loopover-miner/**:\n- ${result.failures.join("\n- ")}`);
    }
    return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVwbG95bWVudC1kb2NzLWF1ZGl0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGVwbG95bWVudC1kb2NzLWF1ZGl0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDhGQUE4RjtBQUM5RixpR0FBaUc7QUFDakcsaUdBQWlHO0FBQ2pHLG1HQUFtRztBQUNuRyxvR0FBb0c7QUFDcEcseUdBQXlHO0FBQ3pHLG9GQUFvRjtBQWtCcEYsb0dBQW9HO0FBQ3BHLE1BQU0sZUFBZSxHQUFHLDBDQUEwQyxDQUFDO0FBRW5FLHVHQUF1RztBQUN2RyxNQUFNLGtCQUFrQixHQUFHLGtEQUFrRCxDQUFDO0FBRTlFLGlFQUFpRTtBQUNqRSxNQUFNLHFCQUFxQixHQUFHLGdCQUFnQixDQUFDO0FBRS9DLDBHQUEwRztBQUMxRyxNQUFNLHFCQUFxQixHQUFHLGlDQUFpQyxDQUFDO0FBRWhFLHdHQUF3RztBQUN4RyxNQUFNLG9CQUFvQixHQUFHLDJDQUEyQyxDQUFDO0FBRXpFLHdHQUF3RztBQUN4RyxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsSUFBWTtJQUMzQyxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQ2pDLEtBQUssTUFBTSxLQUFLLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxDQUFDO1FBQ25ELE1BQU0sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBRSxDQUFDLENBQUM7SUFDeEIsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2hCLENBQUM7QUFFRCxpRkFBaUY7QUFDakYsTUFBTSxVQUFVLG1CQUFtQixDQUFDLFFBQWdCO0lBQ2xELE9BQU8sQ0FBQyxHQUFHLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDaEQsQ0FBQztBQUVELCtGQUErRjtBQUMvRixNQUFNLFVBQVUsdUJBQXVCLENBQUMsUUFBZ0I7SUFDdEQsTUFBTSxRQUFRLEdBQUcsSUFB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