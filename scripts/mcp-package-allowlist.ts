// Canonical MCP published-tarball allowlist (#6291). Shared by check-mcp-package.ts and
// mcp-release-candidate-core.ts so the dry-run gate and the release-candidate tarball check
// cannot drift (the previous duplicated lists already missed shipped lib/*.js files).

export const MCP_PACKAGE_ALLOWED_FILE_PATTERNS: RegExp[] = [
  /^dist\/bin\/loopover-mcp\.js$/,
  /^dist\/lib\/cli-error\.js$/,
  /^dist\/lib\/local-branch\.js$/,
  /^dist\/lib\/format-table\.js$/,
  /^dist\/lib\/redact-local-path\.js$/,
  /^dist\/lib\/telemetry\.js$/,
  /^scripts\/gittensor-score-preview\.(mjs|py)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];
