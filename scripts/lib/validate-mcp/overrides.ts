// Per-tool smoke-call argument overrides (#9520).
//
// Deliberately SMALL, and it must stay that way: every entry here is a place where the schema-
// derived arguments are structurally valid but semantically useless, and each one is a hint that
// the tool's own input schema could describe its expectations better.
//
// A tool that is absent from this map is still smoke-called -- with the synthesized minimum. That
// is the whole design (see synthesize-input.ts): nothing here needs an entry for a new tool.
export const SMOKE_ARGUMENT_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  // Dry-run by default is the tools' own posture; the synthesizer sends `false` for every boolean
  // (the minimum), which would flip these two into their create path. Set explicitly so a smoke
  // call can never open an issue even against a fixture env.
  loopover_generate_contributor_issue_drafts: { dryRun: true, create: false },
  loopover_plan_repo_issues: { dryRun: true, create: false, goal: "validate-mcp smoke call" },
  // A staged approval-queue decision executes the action on accept; reject is the inert branch.
  loopover_decide_pending_action: { decision: "reject" },
  // The write-spec tools compose a shell command from these; a one-character branch name produces a
  // spec no human would read, and `head`/`base` must differ for the spec to make sense.
  loopover_open_pr: { head: "validate-mcp/head", base: "main", title: "validate-mcp smoke call" },
  loopover_create_branch: { branch: "validate-mcp/probe" },
  loopover_delete_branch: { branch: "validate-mcp/probe" },
  // `framework` is an enum whose first member the synthesizer picks; targetFiles needs a real path
  // shape for the spec's criteria to be meaningful.
  loopover_generate_tests: { targetFiles: ["src/index.ts"] },
});

/** The override for one tool, or an empty object. Exported as a function so the driver never has to
 *  care whether an entry exists. */
export function overrideFor(toolName: string): Record<string, unknown> {
  return SMOKE_ARGUMENT_OVERRIDES[toolName] ?? {};
}

/**
 * Paths the release automation reads, asserted to exist by `checkWatchedPathsExist`.
 *
 * Listed here rather than derived because the point is to catch a file being MOVED OR DELETED while
 * the automation still names it -- deriving the list from the same source the automation reads
 * would make the check vacuous.
 */
export const RELEASE_AUTOMATION_WATCHED_PATHS: readonly string[] = Object.freeze([
  "packages/loopover-mcp/package.json",
  "packages/loopover-mcp/CHANGELOG.md",
  "packages/loopover-engine/package.json",
  "packages/loopover-miner/package.json",
  "packages/loopover-miner/expected-engine.version",
  "src/services/mcp-compatibility.ts",
  ".github/workflows/publish-mcp.yml",
  ".github/workflows/publish-engine.yml",
  ".github/workflows/publish-miner.yml",
]);
