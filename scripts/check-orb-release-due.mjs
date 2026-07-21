// Computes whether a new ORB (self-host container image) beta snapshot is due, and what its tag would be.
// Read-only / side-effect-free by design: this script only REPORTS -- the actual `git tag` + `push` (the
// consequential action) happens as explicit, auditable steps in .github/workflows/orb-beta-release.yml, not
// hidden inside this script. See scripts/orb-release-core.ts for the underlying logic and rationale.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildOrbReleaseReport, latestOrbTag, latestStableOrbTag } from "./orb-release-core.js";

const MANIFEST_PATH = "orb-manifest.json";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestVersion = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).version;
  const tags = git(["tag", "--list", "orb-v*"]).split("\n").filter(Boolean);

  const stableTagName = latestStableOrbTag(tags)?.tag ?? null;
  const anyTagName = latestOrbTag(tags)?.tag ?? null;

  const report = buildOrbReleaseReport({
    tags,
    manifestVersion,
    commits: {
      sinceStable: readCommits(stableTagName ? `${stableTagName}..HEAD` : "HEAD"),
      sinceLastTag: readCommits(anyTagName ? `${anyTagName}..HEAD` : "HEAD"),
    },
  });

  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!args.json && !args.output) {
    process.stdout.write(report.due ? `ORB beta due: ${report.nextTag}\n` : "No ORB beta due.\n");
  }
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
