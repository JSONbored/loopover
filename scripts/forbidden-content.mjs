// Single source of truth for the miner package's secret-shape detector.
//
// scripts/check-miner-package.mjs uses this to reject any packed miner file that embeds a secret-like value, and
// the AMS MCP contract test (test/unit/miner-mcp-contract.test.ts) reuses the SAME pattern to assert no MCP tool
// response ever leaks one — importing it here rather than hand-duplicating the regex keeps the two byte-for-byte in
// sync instead of relying on manual vigilance.
export const FORBIDDEN_CONTENT =
  /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;
