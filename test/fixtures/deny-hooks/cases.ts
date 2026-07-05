import type { DenyRule, ProposedToolCall } from "../../../packages/gittensory-miner/lib/deny-hooks.js";

// Table-driven fixture corpus for the deny-hook primitive (#2296). Each case is a realistic tool-call shape a
// future coding-agent driver will actually produce (file writes, shell/git commands, multi-path edits). `rules`
// omitted → the built-in DEFAULT_DENY_RULES. `expected.allowed` is the verdict; `expected.blockedByIncludes` (when
// blocked) is a substring the matched rule's reason must contain. See README.md for the format + how to extend it.

export type DenyHookFixture = {
  name: string;
  toolCall: ProposedToolCall;
  rules?: DenyRule[];
  expected: { allowed: boolean; blockedByIncludes?: string };
};

export const denyHookFixtures: DenyHookFixture[] = [
  // ── workflow-file writes (never touch CI config) ──────────────────────────────────────────────
  {
    name: "blocks a write to a top-level CI workflow file",
    toolCall: { name: "Write", input: { file_path: ".github/workflows/ci.yml" } },
    expected: { allowed: false, blockedByIncludes: "CI workflows" },
  },
  {
    name: "blocks a write to a DEEPLY-nested workflow file (** spans segments)",
    toolCall: { name: "Write", input: { file_path: ".github/workflows/release/deploy.yml" } },
    expected: { allowed: false, blockedByIncludes: "CI workflows" },
  },
  {
    name: "blocks a workflow path EMBEDDED in a shell command (tokenized, not a bare path field)",
    toolCall: { name: "Bash", input: { command: "cat .github/workflows/ci.yml" } },
    expected: { allowed: false, blockedByIncludes: "CI workflows" },
  },
  {
    name: "allows an ordinary source write",
    toolCall: { name: "Write", input: { file_path: "src/signals/foo.ts" } },
    expected: { allowed: true },
  },

  // ── env files (never read/write) ──────────────────────────────────────────────────────────────
  { name: "blocks reading .env", toolCall: { name: "Read", input: { file_path: ".env" } }, expected: { allowed: false, blockedByIncludes: "environment files" } },
  {
    name: "blocks a nested .env.local",
    toolCall: { name: "Read", input: { file_path: "apps/web/.env.local" } },
    expected: { allowed: false, blockedByIncludes: "environment files" },
  },
  {
    name: "GLOB EDGE: `src/environment.ts` is NOT an env file (segment does not start with .env)",
    toolCall: { name: "Write", input: { file_path: "src/environment.ts" } },
    expected: { allowed: true },
  },

  // ── secret-bearing paths ──────────────────────────────────────────────────────────────────────
  {
    name: "blocks a write under a secrets directory",
    toolCall: { name: "Write", input: { file_path: "config/secrets/prod.json" } },
    expected: { allowed: false, blockedByIncludes: "secret-bearing" },
  },
  {
    name: "GLOB EDGE: blocks a less-obvious `secretstore` segment (secret* prefix match, not literal `secrets`)",
    toolCall: { name: "Read", input: { file_path: "app/secretstore/data.bin" } },
    expected: { allowed: false, blockedByIncludes: "secret-bearing" },
  },
  {
    name: "allows an unrelated public directory",
    toolCall: { name: "Read", input: { file_path: "config/public/prod.json" } },
    expected: { allowed: true },
  },

  // ── private key material ──────────────────────────────────────────────────────────────────────
  {
    name: "blocks touching a private key file",
    toolCall: { name: "Read", input: { file_path: "keys/id_private_key.pem" } },
    expected: { allowed: false, blockedByIncludes: "private key" },
  },
  {
    name: "allows a public-notes markdown lookalike",
    toolCall: { name: "Read", input: { file_path: "docs/public-notes.md" } },
    expected: { allowed: true },
  },

  // ── git force-push guard (command content, order-independent) ──────────────────────────────────
  {
    name: "blocks git push --force",
    toolCall: { name: "Bash", input: { command: "git push --force origin main" } },
    expected: { allowed: false, blockedByIncludes: "force-push" },
  },
  {
    name: "blocks --force-with-lease push (contains push + --force, either order)",
    toolCall: { name: "Bash", input: { command: "git --force-with-lease push" } },
    expected: { allowed: false, blockedByIncludes: "force-push" },
  },
  { name: "allows a normal push", toolCall: { name: "Bash", input: { command: "git push origin main" } }, expected: { allowed: true } },
  {
    name: "blocks the short -f force-push flag",
    toolCall: { name: "Bash", input: { command: "git push -f origin main" } },
    expected: { allowed: false, blockedByIncludes: "force-push" },
  },
  {
    name: "GLOB EDGE: --follow-tags is NOT a force flag (token-matched, not a `-f` substring match)",
    toolCall: { name: "Bash", input: { command: "git push --follow-tags origin main" } },
    expected: { allowed: true },
  },
  { name: "allows running the test suite", toolCall: { name: "Bash", input: { command: "npm test" } }, expected: { allowed: true } },

  // ── multi-path edits + custom-rule cases ──────────────────────────────────────────────────────
  {
    name: "blocks a MultiEdit whose paths array includes a workflow file",
    toolCall: { name: "MultiEdit", input: { paths: ["README.md", ".github/workflows/x.yml"] } },
    expected: { allowed: false, blockedByIncludes: "CI workflows" },
  },
  {
    name: "allows a MultiEdit over only ordinary files",
    toolCall: { name: "MultiEdit", input: { paths: ["src/a.ts", "src/b.ts"] } },
    expected: { allowed: true },
  },
  {
    name: "an empty rule set allows everything (even a normally-blocked path)",
    toolCall: { name: "Write", input: { file_path: ".github/workflows/ci.yml" } },
    rules: [],
    expected: { allowed: true },
  },
  {
    name: "a custom exact-tool matcher fires only for that tool",
    toolCall: { name: "Write", input: { file_path: "pnpm-lock.yaml" } },
    rules: [{ matcher: "Write", pathPattern: "**/*lock*", reason: "no lockfile edits" }],
    expected: { allowed: false, blockedByIncludes: "lockfile" },
  },
];
