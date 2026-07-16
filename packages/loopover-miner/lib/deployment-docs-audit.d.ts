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

export function scanEnvVarTokens(text: string): Set<string>;

export function extractEnvVarClaims(markdown: string): string[];

export function extractSubcommandClaims(markdown: string): string[];

export function isRepoRelativePath(target: string): boolean;

export function extractFilePathClaims(markdown: string): string[];

export function scanRegisteredCommands(binSource: string): Set<string>;

export function auditDeploymentDocs(
  claims: DeploymentDocsClaims,
  reality: DeploymentDocsReality,
): DeploymentDocsAuditResult;

export function assertDeploymentDocsInSync(
  claims: DeploymentDocsClaims,
  reality: DeploymentDocsReality,
): DeploymentDocsAuditResult;
