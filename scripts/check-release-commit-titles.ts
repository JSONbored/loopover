// Commit titles release-please cannot parse (#9948).
//
// THE FAILURE THIS EXISTS TO PREVENT IS SILENT. release-please parses each commit as a conventional commit
// to decide the version bump and to write the changelog. A title it cannot parse is DROPPED -- it
// contributes nothing to either -- and the run still reports success. Observed live:
//
//   ❯ commit could not be parsed: 8b446978 fix(miner): discover --dry-run must not create/migrate/prune
//                                 the event ledger (#9679) (#9905)
//   ❯ error message: Error: unexpected token '(' at 12:37, valid tokens [)]
//
// Two shipped `fix(miner):` commits were invisible to the release when this was found. Nothing anywhere
// said so: the job was green, and the only evidence was buried in its logs.
//
// The offending shape is a DOUBLE issue/PR suffix -- `(#9679) (#9905)` -- which this repo produces whenever
// a PR title already carries the issue number and the merge appends the PR number. Checked here, before
// release-please runs, rather than by scraping its logs afterwards: a title is a fact available at commit
// time, and a guard that fires on the input is one nobody has to remember to read.
import { execFileSync } from "node:child_process";

/**
 * A conventional-commit header ending in two or more parenthesised references.
 *
 * Deliberately narrow. It matches the one shape observed to break the parser rather than trying to
 * reimplement conventional-commits' grammar -- a broad "does this parse?" reimplementation would drift from
 * the real parser and start rejecting titles release-please handles fine, and a checker that cries wolf gets
 * muted. Widen it when a second shape is actually observed failing, not in anticipation.
 */
export const UNPARSEABLE_TITLE = /\(#\d+\)\s*\(#\d+\)\s*$/;

/** Does this commit subject carry the double-reference suffix release-please chokes on? */
export function hasUnparseableTitle(subject: string): boolean {
  return UNPARSEABLE_TITLE.test(subject.trim());
}

/** Subjects release-please would silently drop, from a list of `<sha> <subject>` lines. */
export function findUnparseableCommits(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const subject = line.slice(line.indexOf(" ") + 1);
    return line.trim() !== "" && hasUnparseableTitle(subject);
  });
}

/**
 * `<sha> <subject>` for the commits THIS branch adds on top of the base.
 *
 * Scoped to the branch's own commits, NOT to everything since the last release tag. Git history is
 * immutable: `main` already carries titles of this shape, and a check that failed on those would be
 * permanently red and would block every unrelated PR -- so it would be turned off within a day. Guarding
 * the commits a change actually introduces stops the class going forward, which is the only thing a
 * pre-merge gate can honestly do about titles that already shipped.
 *
 * Empty (a clean pass) when the base is unavailable, e.g. a shallow clone with no `origin/main`.
 */
function commitsOnThisBranch(base: string): string[] {
  try {
    return execFileSync("git", ["log", "--format=%h %s", `${base}..HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main(): void {
  const base = process.env.LOOPOVER_RELEASE_TITLE_BASE ?? "origin/main";
  const offenders = findUnparseableCommits(commitsOnThisBranch(base));
  if (offenders.length > 0) {
    console.error(`check-release-commit-titles: ${offenders.length} commit title(s) release-please cannot parse, so it will DROP them from the version bump and the changelog (#9948):\n`);
    for (const line of offenders) console.error(`  ${line}`);
    console.error(
      [
        "",
        "A title must carry at most ONE parenthesised reference. Use:",
        "  fix(scope): subject (#PR)",
        "and put the issue in the body (`Closes #123`), which is where release-please reads it from anyway.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`check-release-commit-titles: every commit title on this branch (vs ${base}) parses.`);
}

if (process.argv[1]?.endsWith("check-release-commit-titles.ts")) main();
