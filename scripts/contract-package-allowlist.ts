// Canonical @loopover/contract published-tarball allowlist (#9654).
//
// Declared SEPARATELY from MCP_PACKAGE_ALLOWED_FILE_PATTERNS on purpose: the two packages ship
// completely different trees (the CLI ships named dist/bin and dist/lib entrypoints plus a scripts/
// helper; the contract ships a whole dist/ of schema modules), so sharing one list would either
// over-permit the CLI or under-permit the contract, and a shared list is exactly how a package
// starts shipping a file nobody reviewed.
export const CONTRACT_PACKAGE_ALLOWED_FILE_PATTERNS: RegExp[] = [
  // Every emitted module, its declarations and its source maps. The exports map has eight subpaths and
  // grows with the contract, so enumerating files by name here would be a maintenance trap that fails
  // the release rather than catching anything.
  /^dist\/.+\.(js|d\.ts|js\.map|d\.ts\.map)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];
