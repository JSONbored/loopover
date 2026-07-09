// Public-safe rendering for AI-generated E2E test coverage (#4193, part of the #4189 epic).
//
// Unlike fix-handoff (which splices a block into the automated review's sticky unified comment), this
// renders its OWN dedicated reply comment for the `@gittensory generate-tests` command (#4195) — a
// maintainer-triggered, on-demand action, not something that runs on every automated review pass. This
// mirrors how `explain`/`configuration` already post their own on-demand response comments rather than
// editing the main review comment (see `maybeProcessExplainCommand` in `src/queue/processors.ts`).
//
// This layer never re-derives safety: it trusts that #4191's `parseE2eTestGenResponse` already validated
// the test source is plausible Playwright before this ever sees it, and that #4195's caller already
// resolved authorization — this file only turns already-decided content into a public-safe comment body.
import { AGENT_COMMAND_COMMENT_MARKER } from "../github/comments";
import { gittensoryFooter } from "../github/footer";

/** Outcome of an attempted `commit`-mode delivery (#4197), or its absence entirely (comment-only mode, or
 *  generation itself produced nothing usable — see `buildE2eTestGenCommentBody`'s own null-testSource
 *  branch). `blocked` is distinct from `declined`: it means commit delivery was never attempted because the
 *  PR author is a confirmed Gittensor miner (#4201's scoring-integrity safeguard), not a GitHub-side failure. */
export type E2eTestGenCommitOutcome =
  | { status: "committed"; commitSha: string; htmlUrl: string }
  | { status: "declined"; reason: string }
  | { status: "blocked" };

export type E2eTestGenCommentInput = {
  actor: string;
  /** The generated test source, or null when generation ran but produced nothing usable. */
  testSource: string | null;
  framework?: string | undefined;
  /** Present only when `commit` delivery mode was configured AND generation produced a usable test. Absent
   *  for comment-only delivery — the generated test always renders as a suggestion in that case. */
  commit?: E2eTestGenCommitOutcome | undefined;
};

function markdownFenceFor(source: string): string {
  const backtickRunLengths = Array.from(source.matchAll(/`+/g), (match) => match[0]!.length);
  const longestBacktickRun = Math.max(0, ...backtickRunLengths);
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

/**
 * Build the PR-comment body for a `@gittensory generate-tests` result. A null `testSource` renders a
 * clear "nothing usable" note rather than silently posting no comment at all — the maintainer who invoked
 * the command should always get a response, even a negative one. When `commit` delivery succeeded, the
 * comment links to the pushed commit instead of repeating its content (the commit IS the deliverable); when
 * it was declined or blocked, the comment explains why AND still renders the generated test as a suggestion,
 * so a maintainer never loses the generated content just because the heavier delivery mode didn't apply.
 */
export function buildE2eTestGenCommentBody(input: E2eTestGenCommentInput): string {
  const framework = input.framework?.trim() || "Playwright";
  if (!input.testSource) {
    return [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **E2E test generation for @${input.actor} did not produce a usable result**`,
      `> The model's output didn't parse as valid ${framework} source — try again, or add the test by hand.`,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n");
  }
  if (input.commit?.status === "committed") {
    return [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **AI-generated ${framework} test for @${input.actor} — pushed as a commit**`,
      `> [View the commit](${input.commit.htmlUrl}) (\`${input.commit.commitSha.slice(0, 7)}\`). This is a suggestion, not a guarantee — review it like any other test before merging.`,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n");
  }
  const declineNote =
    input.commit?.status === "declined"
      ? [`> Commit delivery was requested but declined: ${input.commit.reason}. Posting it as a suggestion instead.`, ""]
      : input.commit?.status === "blocked"
        ? [
            "> Commit delivery was requested, but this PR's author is a confirmed Gittensor miner — a maintainer-authored commit is never pushed onto a scored contribution's branch, to keep the externally-computed score honest. Posting it as a suggestion instead.",
            "",
          ]
        : [];
  const fence = markdownFenceFor(input.testSource);
  return [
    AGENT_COMMAND_COMMENT_MARKER,
    "",
    "> [!NOTE]",
    `> **AI-generated ${framework} test for @${input.actor}**`,
    "> This is a suggestion, not a guarantee — review it like any other test before merging.",
    ...declineNote,
    "",
    `${fence}typescript`,
    input.testSource,
    fence,
    "",
    "---",
    gittensoryFooter(),
  ].join("\n");
}
