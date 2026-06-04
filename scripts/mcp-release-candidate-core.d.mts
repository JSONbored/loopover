export const RELEASE_TAG_PATTERN: RegExp;

export type CheckResult = {
  ok: boolean;
  code: string;
  message: string;
};

export type TarballCheckResult = CheckResult & {
  unexpected: string[];
  secretFiles: string[];
};

export type TokenlessCheckResult = CheckResult & {
  issues: string[];
};

export type ReleaseCandidateReport = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; code: string; message: string }>;
  failures: Array<{ name: string; ok: boolean; code: string; message: string }>;
  nextSteps: string[];
};

export function parseReleaseTag(tag: string | null | undefined): { valid: boolean; version: string | null };
export function expectedReleaseTag(version: string): string;
export function checkTag(input: { tag: string | null | undefined; packageVersion: string | null | undefined }): CheckResult;
export function changelogHasVersionSection(changelog: string | null | undefined, version: string | null | undefined): boolean;
export function checkChangelog(input: { changelog: string | null | undefined; version: string }): CheckResult;
export function unexpectedTarballFiles(files: string[] | null | undefined): string[];
export function fileLooksLikeSecret(content: string | null | undefined): boolean;
export function checkTarball(input: { files: string[] | null | undefined; contentsByFile?: Record<string, string> }): TarballCheckResult;
export function checkTokenlessPublish(workflowYaml: string | null | undefined): TokenlessCheckResult;
export function buildReleaseCandidateReport(checks: Record<string, (CheckResult & { tag?: string }) | undefined>): ReleaseCandidateReport;
export function redactSensitive(text: string | null | undefined): string;
