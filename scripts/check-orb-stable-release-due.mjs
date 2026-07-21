// Computes whether a new STABLE (non-beta) ORB release is due, and what its proposed version would be.
// Read-only / side-effect-free by design, mirroring check-orb-release-due.mjs's own reasoning: the actual
// orb-manifest.json bump + `git tag` + PR create/update (the consequential actions) happen as explicit,
// auditable steps in .github/workflows/orb-stable-release-pr.yml, not hidden inside this script. See
// scripts/orb-release-core.ts's buildOrbStableReleaseReport for the underlying logic and rationale.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildOrbStableReleaseReport } from "./orb-release-core.js";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tags = git(["tag", "--list", "orb-v*"]).split("\n").filter(Boolean);
  const stableTagName = latestStableTagName(tags);

  const report = buildOrbStableReleaseReport({
    tags,
    commitsSinceStable: readCommits(stableTagName ? `${stableTagName}..HEAD` : "HEAD"),
  });

  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!args.json && !args.output) {
    process.stdout.write(report.due ? `ORB stable release due: orb-v${report.nextVersion}\n` : "No ORB stable release due.\n");
  }
}

// Same tag-selection concern as check-orb-release-due.mjs's latestStableTagName -- kept here (not exported
// from the core module) since it's a git-log concern, not a pure-logic one.
function latestStableTagName(tags) {
  const stable = tags.filter((tag) => /^orb-v\d+\.\d+\.\d+$/.test(tag));
  return stable.sort(compareTagsDesc)[0] ?? null;
}

function compareTagsDesc(left, right) {
  return right.localeCompare(left, undefined, { numeric: true });
}

function parseArgs(argv) {
  const args = { json: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function readCommits(revisionRange) {
  const format = "%x1e%H%x1f%s%x1f%B";
  const logOutput = git(["log", "--reverse", "--no-merges", `--format=${format}`, revisionRange]);
  return logOutput
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...bodyParts] = entry.split("\x1f");
      return { sha, subject: subject?.split("\n")[0] ?? "", body: bodyParts.join("\x1f"), files: readCommitFiles(sha) };
    });
}

function readCommitFiles(sha) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 });
}

main();
