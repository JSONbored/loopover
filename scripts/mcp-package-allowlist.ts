// Canonical MCP published-tarball allowlist (#6291). Shared by check-mcp-package.mjs and
// mcp-release-candidate-core.ts so the dry-run gate and the release-candidate tarball check
// cannot drift (the previous duplicated lists already missed shipped lib/*.js files).

export const MCP_PACKAGE_ALLOWED_FILE_PATTERNS: RegExp[] = [
  /^bin\/loopover-mcp\.js$/,
  /^lib\/cli-error\.js$/,
  /^lib\/local-branch\.js$/,
  /^lib\/format-table\.js$/,
  /^lib\/redact-local-path\.js$/,
  /^lib\/telemetry\.js$/,
  /^scripts\/gittensor-score-preview\.(mjs|py)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];
