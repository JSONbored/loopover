// Single source of truth for the miner package's secret-shape detector.
//
// scripts/check-miner-package.mjs + scripts/check-mcp-package.mjs use this to reject any packed miner/mcp file
// that embeds a secret-like value, and the AMS MCP contract test (test/unit/miner-mcp-contract.test.ts) reuses
// the SAME pattern to assert no MCP tool response ever leaks one — importing it here rather than hand-duplicating
// the regex keeps every consumer byte-for-byte in sync instead of relying on manual vigilance.
//
// The concrete provider-key shapes below are hand-copied (#7433) from the exact regex bodies of the entries in
// src/review/secret-patterns.ts's SECRET_PATTERNS that are in its HARD_SECRET_KINDS set (the "near-zero
// false-positive" subset). They are NOT imported directly: this file is a plain `.mjs` run via `node`
// (test:miner-pack / test:mcp-pack), and secret-patterns.ts is TypeScript with no runtime `.js` sibling on this
// path — a runtime `import` of it from node would fail, so the exact bodies are copied per the issue's stated
// fallback. `jwt`, `seed_or_mnemonic`, and `bittensor_key` are deliberately NOT included: jwt is out of scope
// for #7433, and seed_or_mnemonic/bittensor_key are documented in secret-patterns.ts as weak, false-positive-
// prone heuristics intentionally excluded from HARD_SECRET_KINDS (an ordinary `coldkey:` / `hotkey =` line or
// the word "mnemonic" in Bittensor docs is not a leaked credential).
export const FORBIDDEN_CONTENT: RegExp = new RegExp(
  [
    // Already covered before #7433 (unchanged shapes):
    "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY",
    "github_pat_[A-Za-z0-9_]+",
    "gh[pousr]_[A-Za-z0-9_]+",
    "gts_[0-9a-f]{64}",
    "[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=",
    // Added #7433 — exact bodies from secret-patterns.ts HARD_SECRET_KINDS entries:
    "\\bAKIA[0-9A-Z]{16}\\b", // aws_access_key
    "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", // slack_token
    "\\bAIza[0-9A-Za-z_-]{35}\\b", // google_api_key
    "\\bglpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])", // gitlab_token
    "\\bnpm_[A-Za-z0-9]{36}\\b", // npm_token
    "\\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\\b", // stripe_secret_key
    "\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])", // sendgrid_key
    "\\bhf_[A-Za-z0-9]{34}\\b", // huggingface_token
    "\\b(?:pa|al)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])", // voyage_api_key
    "\\bfc-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])", // firecrawl_api_key
    "\\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\\b", // openai_api_key
    "\\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\\b", // anthropic_api_key
  ].join("|"),
);
