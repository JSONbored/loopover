import type { JsonValue } from "../types";

// #780 miner write-tools. These build ACTION SPECS — gittensory supplies the content; the miner's OWN local
// harness runs the command with its OWN GitHub credentials. Gittensory (and this MCP package) NEVER perform
// the write, so source code and the write both stay on the miner's machine: the no-cloud-write boundary holds.
// Pure + deterministic: every builder returns a self-contained, shell-safe spec and touches nothing.

export const LOCAL_WRITE_BOUNDARY =
  "Run this locally with your OWN GitHub credentials (e.g. an authenticated `gh`/`git`). Gittensory supplies the content but never performs the write — your code and the action both stay on your machine.";

export type LocalWriteActionSpec = {
  action: string;
  description: string;
  // The structured parameters, so the harness can construct its own invocation instead of running `command` raw.
  inputs: Record<string, JsonValue>;
  // A directly-runnable, shell-safe command (single-quoted) for harnesses that prefer to exec it as-is.
  command: string;
  boundary: string;
};

// POSIX single-quote escaping: wrap in single quotes and escape embedded single quotes. Safe against injection
// when the harness runs `command` verbatim.
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function spec(action: string, description: string, inputs: Record<string, JsonValue>, command: string): LocalWriteActionSpec {
  return { action, description, inputs, command, boundary: LOCAL_WRITE_BOUNDARY };
}

/** Open a PR from a local branch (content typically taken from gittensory's prepare_pr_packet). */
export function buildOpenPrSpec(input: { repoFullName: string; base: string; head: string; title: string; body: string; draft?: boolean | undefined }): LocalWriteActionSpec {
  const draft = input.draft === true;
  const command = `gh pr create --repo ${sq(input.repoFullName)} --base ${sq(input.base)} --head ${sq(input.head)} --title ${sq(input.title)} --body ${sq(input.body)}${draft ? " --draft" : ""}`;
  return spec("open_pr", "Open a pull request from your local branch.", { repoFullName: input.repoFullName, base: input.base, head: input.head, title: input.title, body: input.body, draft }, command);
}

/** File an issue (e.g. an issue-discovery proposal). */
export function buildFileIssueSpec(input: { repoFullName: string; title: string; body: string; labels?: string[] | undefined }): LocalWriteActionSpec {
  const labels = input.labels ?? [];
  const labelArgs = labels.map((label) => ` --label ${sq(label)}`).join("");
  const command = `gh issue create --repo ${sq(input.repoFullName)} --title ${sq(input.title)} --body ${sq(input.body)}${labelArgs}`;
  return spec("file_issue", "File a new issue.", { repoFullName: input.repoFullName, title: input.title, body: input.body, labels }, command);
}

/** Add labels to an issue or PR (gh issue edit also targets PRs). */
export function buildApplyLabelsSpec(input: { repoFullName: string; number: number; labels: string[] }): LocalWriteActionSpec {
  const labelArgs = input.labels.map((label) => ` --add-label ${sq(label)}`).join("");
  const command = `gh issue edit ${input.number} --repo ${sq(input.repoFullName)}${labelArgs}`;
  return spec("apply_labels", "Add labels to an issue or pull request.", { repoFullName: input.repoFullName, number: input.number, labels: input.labels }, command);
}

/** Post an eligibility/context comment on an issue or PR. */
export function buildPostEligibilityCommentSpec(input: { repoFullName: string; number: number; body: string }): LocalWriteActionSpec {
  const command = `gh issue comment ${input.number} --repo ${sq(input.repoFullName)} --body ${sq(input.body)}`;
  return spec("post_eligibility_comment", "Post an eligibility/context comment on an issue or pull request.", { repoFullName: input.repoFullName, number: input.number, body: input.body }, command);
}

/** Create a local branch off an optional base. */
export function buildCreateBranchSpec(input: { branch: string; base?: string | undefined }): LocalWriteActionSpec {
  const command = input.base ? `git switch -c ${sq(input.branch)} ${sq(input.base)}` : `git switch -c ${sq(input.branch)}`;
  return spec("create_branch", "Create a local branch.", { branch: input.branch, ...(input.base ? { base: input.base } : {}) }, command);
}

/** Delete a branch locally, and optionally on the remote. */
export function buildDeleteBranchSpec(input: { branch: string; remote?: boolean | undefined }): LocalWriteActionSpec {
  const local = `git branch -D ${sq(input.branch)}`;
  const command = input.remote === true ? `${local} && git push origin --delete ${sq(input.branch)}` : local;
  return spec("delete_branch", "Delete a branch (locally, and optionally on origin).", { branch: input.branch, remote: input.remote === true }, command);
}

// #2188 (boundary-safe test-generation slice of #1972). Unlike the write-tools above, there is no single CLI
// verb that "scaffolds a test file" across vitest/jest/pytest/go test/rspec/cargo test — so `command` here is a
// safe, informative `echo` of the plan (target files + boundary criteria) rather than a real write, and the
// actual scaffolding is left to the contributor's OWN agent reading the structured `inputs`. This keeps the same
// no-cloud-write guarantee as every other spec in this file: gittensory supplies WHAT test cases should exist at
// which boundaries, never the test file content or its execution.
export function buildTestGenSpec(input: {
  repoFullName: string;
  targetFiles: string[];
  framework: string;
  testDir?: string | null | undefined;
  criteria?: string[] | undefined;
}): LocalWriteActionSpec {
  const criteria = input.criteria ?? [];
  const testDir = input.testDir ?? null;
  const targetList = input.targetFiles.join(", ");
  const criteriaList = criteria.length > 0 ? ` Boundary-safe criteria: ${criteria.join("; ")}.` : "";
  const location = testDir ? ` under ${testDir}` : " co-located with the source it covers";
  const description = `Scaffold ${input.framework} tests${location} for: ${targetList}.${criteriaList}`;
  const command = `echo ${sq(description)}`;
  return spec(
    "generate_tests",
    description,
    { repoFullName: input.repoFullName, targetFiles: input.targetFiles, framework: input.framework, testDir, criteria },
    command,
  );
}
