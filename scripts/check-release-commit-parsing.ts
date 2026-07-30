// Commits release-please would SILENTLY DROP from the release (#9948).
//
// release-please parses each commit as a conventional commit to decide the version bump and to write the
// changelog. A message it cannot parse contributes to NEITHER -- and the run still reports success. Two
// shipped `fix(miner):` commits were invisible to the release when this was found; the only evidence was a
// line buried in the job's logs:
//
//   ❯ commit could not be parsed: 8b446978 fix(miner): discover --dry-run must not create/migrate/prune …
//   ❯ error message: Error: unexpected token '(' at 12:37, valid tokens [)]
//
// THE TRIGGER IS NESTED PARENTHESES IN THE BODY, not anything about the subject line. Confirmed by driving
// release-please's own parser:
//
//   `existsSync(resolveEventLedgerDbPath(env))` at body col 1  -> 0 commits parsed  (DROPPED)
//   foo(bar(baz)) in the body                                  -> 0 commits parsed  (DROPPED)
//   the SAME nested text further along the line                -> 1 commit  parsed  (fine)
//   foo(bar) in the body                                       -> 1 commit  parsed  (fine)
//   a subject ending in "(#9679) (#9905)"                      -> 1 commit  parsed  (fine)
//
// It is POSITION-SENSITIVE -- the error names a column -- so no hand-written pattern can express it. That
// is the case for driving the parser rather than matching on shapes.
//
// That last line matters: the double issue/PR suffix LOOKS like the culprit and is not. An earlier cut of
// this checker guarded exactly that shape and would have caught nothing while reading as protection.
//
// So this does not pattern-match the message at all. It runs THE ACTUAL PARSER release-please uses and
// asserts every commit survives it. There is no regex to drift from the real behaviour, and the check
// automatically tracks whatever the parser does after a dependency bump -- which is the same
// "compute the fact, don't remember it" bar #9860 sets for every other guard here.
import { execFileSync } from "node:child_process";

/** A commit reduced to what the parser needs. `files` is required by the API but irrelevant to parsing. */
export type CandidateCommit = { sha: string; message: string };

/**
 * The commits release-please's own parser drops, given a list of candidates.
 *
 * `parseConventionalCommits` returns FEWER entries than it was given rather than throwing, which is exactly
 * why the failure is silent in production: the caller gets a shorter array and no error. Comparing counts
 * per-commit is the only way to see it.
 *
 * Injectable so the unit tests can drive it without spawning git.
 */
export async function findUnparseableCommits(
  commits: readonly CandidateCommit[],
  parse?: ConventionalCommitParser,
): Promise<CandidateCommit[]> {
  const parseFn = parse ?? (await loadReleasePleaseParser());
  const dropped: CandidateCommit[] = [];
  for (const commit of commits) {
    // One at a time: a batch call returns a flat array, so a single dropped commit is invisible in the total.
    const parsed = parseFn([{ sha: commit.sha, message: commit.message, files: ["src/x.ts"] }]);
    if (parsed.length === 0) dropped.push(commit);
  }
  return dropped;
}

/** release-please's own `parseConventionalCommits`, typed from the package rather than re-declared here so
 *  a signature change on upgrade is a build error instead of a silently-wrong cast. */
export type ConventionalCommitParser = (typeof import("release-please/build/src/commit.js"))["parseConventionalCommits"];

/** Loaded lazily so the function above stays drivable from a test without importing release-please twice. */
async function loadReleasePleaseParser(): Promise<ConventionalCommitParser> {
  return (await import("release-please/build/src/commit.js")).parseConventionalCommits;
}

/**
 * The commits THIS branch adds over its base.
 *
 * Scoped to the branch, NOT to everything since the last release tag. Git history is immutable and `main`
 * already carries messages the parser drops, so a check that failed on those would be permanently red, would
 * block every unrelated PR, and would be switched off within a day. Guarding the commits a change introduces
 * stops the class going forward -- the only thing a pre-merge gate can honestly do about what already shipped.
 */
export function commitsOnThisBranch(base: string): CandidateCommit[] {
  let shas: string[];
  try {
    shas = execFileSync("git", ["log", "--format=%H", `${base}..HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    // No base to compare against (a shallow clone with no origin/main). A guard that cannot see the range
    // passes rather than inventing a verdict.
    return [];
  }
  return shas.map((sha) => ({
    sha,
    message: execFileSync("git", ["log", "-1", "--format=%B", sha], { encoding: "utf8" }),
  }));
}

async function main(): Promise<void> {
  const base = process.env.LOOPOVER_RELEASE_PARSE_BASE ?? "origin/main";
  const commits = commitsOnThisBranch(base);
  const dropped = await findUnparseableCommits(commits);

  if (dropped.length > 0) {
    console.error(`check-release-commit-parsing: release-please DROPS ${dropped.length} of this branch's ${commits.length} commit(s) -- they would contribute nothing to the version bump or the changelog, and the release would still report success (#9948):\n`);
    for (const commit of dropped) console.error(`  ${commit.sha.slice(0, 9)} ${commit.message.split("\n")[0]}`);
    console.error(
      [
        "",
        "The usual cause is NESTED PARENTHESES in the commit body, e.g.",
        "  `existsSync(resolveEventLedgerDbPath(env))`",
        "Rewrite the inner call so the parens do not nest -- backticks do not protect it:",
        "  `existsSync` of `resolveEventLedgerDbPath`",
        "",
        "Amend the message (`git commit --amend`, or rebase for an older one) and re-run.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`check-release-commit-parsing: release-please parses all ${commits.length} commit(s) on this branch (vs ${base}).`);
}

if (process.argv[1]?.endsWith("check-release-commit-parsing.ts")) await main();
