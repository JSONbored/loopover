// Docs-accuracy audit for the miner's DEPLOYMENT.md (#5180). Mirrors the self-host docs audit
// (apps/loopover-ui/src/lib/selfhost-docs-audit.ts): parse the deployment doc, then assert every
// LOOPOVER_MINER_* / MINER_* env var, repo-relative file path, and `loopover-miner <subcommand>`
// it documents still exists under packages/loopover-miner/**. A rename or move that leaves the doc
// stale then fails CI with a message naming the exact stale claim, instead of misleading operators.
// Wired into CI via `npm run test:miner-deployment-docs-audit` (scripts/check-miner-deployment-docs.ts)
// and the live unit suite in test/unit/miner-deployment-docs-audit.test.ts (#6158).

/** Parsed claims a DEPLOYMENT.md makes about the miner's runtime surface. */
export type DeploymentDocsClaims = {
  envVars: string[];
  filePaths: string[];
  subcommands: string[];
};

/** Filesystem-independent view of the live source tree the parsed claims are checked against. */
export type DeploymentDocsReality = {
  hasEnvRead: (name: string) => boolean;
  /** The enumerable set of every real env-var read, so the reverse audit direction (#6601) can diff a real
   *  `LOOPOVER_MINER_*` read that DEPLOYMENT.md never documents, not just probe one documented name at a time. */
  envReads: Iterable<string>;
  pathExists: (relativePath: string) => boolean;
  isRegisteredCommand: (name: string) => boolean;
};

/** Result of cross-checking claims against reality: `ok` plus a message per stale claim. */
export type DeploymentDocsAuditResult = {
  ok: boolean;
  failures: string[];
};

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
export function scanEnvVarTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(ENV_VAR_PATTERN)) {
    tokens.add(match[0]);
  }
  return tokens;
}

/** Sorted, de-duplicated env-var names DEPLOYMENT.md claims the miner honors. */
export function extractEnvVarClaims(markdown: string): string[] {
  return [...scanEnvVarTokens(markdown)].sort();
}

/** Sorted, de-duplicated `loopover-miner <subcommand>` subcommands DEPLOYMENT.md documents. */
export function extractSubcommandClaims(markdown: string): string[] {
  const commands = new Set<string>();
  for (const match of markdown.matchAll(SUBCOMMAND_PATTERN)) {
    commands.add(match[1]!);
  }
  return [...commands].sort();
}

/** True when a markdown link target is an on-disk repo path (not a URL, anchor, or runtime path). */
export function isRepoRelativePath(target: string): boolean {
  return !NON_REPO_LINK_PATTERN.test(target);
}

/** Sorted, de-duplicated repo-relative file paths DEPLOYMENT.md links to (external issue links excluded).
 *  An in-file anchor fragment (`file.md#heading`) is stripped before the path is recorded -- the fragment
 *  names a heading inside the target file, not a filesystem entry, so checking it against `pathExists`
 *  verbatim would always fail even when the linked file (and heading) both genuinely exist. */
export function extractFilePathClaims(markdown: string): string[] {
  const paths = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
    const target = match[1]!.trim();
    if (isRepoRelativePath(target)) {
      const [pathOnly] = target.split("#");
      paths.add(pathOnly!);
    }
  }
  return [...paths].sort();
}

/** The set of top-level subcommands the miner CLI dispatches, parsed from its bin entry source. */
export function scanRegisteredCommands(binSource: string): Set<string> {
  const commands = new Set<string>();
  for (const match of binSource.matchAll(CLI_DISPATCH_PATTERN)) {
    commands.add(match[1]!);
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
export function auditDeploymentDocs(claims: DeploymentDocsClaims, reality: DeploymentDocsReality): DeploymentDocsAuditResult {
  const failures: string[] = [];
  for (const name of claims.envVars) {
    if (!reality.hasEnvRead(name)) {
      failures.push(
        `env var "${name}" is documented in DEPLOYMENT.md but no read of it exists under packages/loopover-miner/**`,
      );
    }
  }
  for (const path of claims.filePaths) {
    if (!reality.pathExists(path)) {
      failures.push(`file path "${path}" is linked from DEPLOYMENT.md but no longer exists on disk`);
    }
  }
  for (const command of claims.subcommands) {
    if (!reality.isRegisteredCommand(command)) {
      failures.push(
        `CLI subcommand "loopover-miner ${command}" is documented in DEPLOYMENT.md but is not registered in the CLI command table`,
      );
    }
  }
  // Reverse direction (#6601): a real `LOOPOVER_MINER_*` env-var read that DEPLOYMENT.md never documents. Scoped
  // to the `LOOPOVER_MINER_` prefix and excluding the `*_DB` family (documented generically via one pattern
  // sentence, not enumerated) and the bare `MINER_*` alias namespace (which also matches non-env event/metric/
  // filename constants). `reality.envReads` is the enumerable set of real reads the forward `hasEnvRead` probes.
  const documented = new Set(claims.envVars);
  for (const name of reality.envReads) {
    if (name.startsWith("LOOPOVER_MINER_") && !name.endsWith("_DB") && !documented.has(name)) {
      failures.push(
        `env var "${name}" is read under packages/loopover-miner/** but is not documented in DEPLOYMENT.md`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Run the audit and throw a build-failing error naming every stale claim; returns the result when in sync. */
export function assertDeploymentDocsInSync(claims: DeploymentDocsClaims, reality: DeploymentDocsReality): DeploymentDocsAuditResult {
  const result = auditDeploymentDocs(claims, reality);
  if (!result.ok) {
    throw new Error(
      `DEPLOYMENT.md is out of sync with packages/loopover-miner/**:\n- ${result.failures.join("\n- ")}`,
    );
  }
  return result;
}
