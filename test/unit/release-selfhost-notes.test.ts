import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Extracted straight out of the committed workflow YAML (same technique as the "Resolve version" step
// tests in release-selfhost-prerelease.test.ts), so a regression in the actual bash fails this test
// instead of only surfacing on a real tag push.
function readGithubReleaseStep(): string {
  const workflow = parse(readFileSync(".github/workflows/release-selfhost.yml", "utf8")) as {
    jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
  };
  const step = workflow.jobs.release.steps.find((s) => s.name === "GitHub Release");
  if (!step?.run) throw new Error('step "GitHub Release" not found or has no run: block');
  return step.run;
}

interface HarnessOptions {
  /** Lines "git tag -l 'orb-v*' --sort=-creatordate" should print, newest first. */
  tagList: string[];
  /** Body the fake "gh api .../releases/generate-notes" call returns; omit to simulate the API failing. */
  changelogBody?: string;
  /** Whether "gh release view" should report the release as already existing (drives create vs edit). */
  releaseExists?: boolean;
}

function createHarness(options: HarnessOptions) {
  const dir = mkdtempSync(join(tmpdir(), "gtorb-release-notes-"));
  const binDir = join(dir, "bin");
  const callsLog = join(dir, "calls.log");
  const notesFile = join(dir, "notes-passed.txt");
  mkdirSync(binDir);
  tmpDirs.push(dir);

  writeFileSync(join(dir, "changelog-body.json"), JSON.stringify({ body: options.changelogBody ?? "" }));

  writeFileSync(
    join(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$CALLS_LOG"
if [ "$1" = "tag" ]; then
  printf '%s\\n' ${options.tagList.map((t) => `"${t}"`).join(" ")}
  exit 0
fi
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 1
`,
  );
  chmodSync(join(binDir, "git"), 0o755);

  const generateNotesExit = options.changelogBody === undefined ? 1 : 0;
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$CALLS_LOG"
if [ "$1" = "api" ]; then
  if [ "${generateNotesExit}" = "1" ]; then
    exit 1
  fi
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.CHANGELOG_FILE, 'utf8')).body)"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  exit ${options.releaseExists ? "0" : "1"}
fi
if [ "$1" = "release" ] && { [ "$2" = "create" ] || [ "$2" = "edit" ]; }; then
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--notes" ]; then
      printf '%s' "$arg" > "$NOTES_FILE"
    fi
    prev="$arg"
  done
  exit 0
fi
printf 'unexpected gh invocation: %s\\n' "$*" >&2
exit 1
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);

  return {
    dir,
    run() {
      const run = readGithubReleaseStep();
      const result = spawnSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CALLS_LOG: callsLog,
          NOTES_FILE: notesFile,
          CHANGELOG_FILE: join(dir, "changelog-body.json"),
          GH_TOKEN: "test-token",
          GITHUB_REPOSITORY: "JSONbored/gittensory",
          REF_NAME: "orb-v0.2.0",
          RELEASE_VERSION: "0.2.0",
          RELEASE_TAG: "orb-v0.2.0",
          RELEASE_ID: "gittensory-orb@0.2.0",
          REPOSITORY_OWNER: "JSONbored",
          PRERELEASE: "false",
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        calls: readOptional(callsLog),
        notesPassed: readOptional(notesFile),
      };
    },
  };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe('release-selfhost.yml "GitHub Release" step changelog generation', () => {
  it("appends the generated changelog to the plain notes when a previous orb-v tag exists", () => {
    const harness = createHarness({
      tagList: ["orb-v0.2.0", "orb-v0.1.0", "orb-v0.1.0-beta.2", "orb-v0.1.0-beta.1"],
      changelogBody: "## What's Changed\n* feat: something by @someone in .../pull/1",
    });
    const r = harness.run();
    expect(r.status).toBe(0);
    expect(r.notesPassed).toContain("docker pull ghcr.io/jsonbored/gittensory-selfhost:orb-v0.2.0");
    expect(r.notesPassed).toContain("## What's Changed");
    expect(r.notesPassed).toContain("feat: something");
    // The tag being released must never be diffed against itself.
    expect(r.calls).toContain("previous_tag_name=orb-v0.1.0");
    expect(r.calls).not.toContain("previous_tag_name=orb-v0.2.0");
    // Lock the explicit range as ONE call, not just two substrings present somewhere in the log --
    // tag_name and previous_tag_name must be parameters of the same generate-notes invocation.
    const apiCall = r.calls.split("\n").find((line) => line.includes("gh api"));
    expect(apiCall).toContain("tag_name=orb-v0.2.0");
    expect(apiCall).toContain("previous_tag_name=orb-v0.1.0");
  });

  it("falls back to the plain notes with no changelog section when there is no prior orb-v tag", () => {
    // The very-first-release case: the tag list contains only the tag being released, so PREV_TAG
    // resolves empty and the generate-notes call must be skipped entirely (not even attempted).
    const harness = createHarness({ tagList: ["orb-v0.2.0"], changelogBody: "## What's Changed\n* whatever" });
    const r = harness.run();
    expect(r.status).toBe(0);
    expect(r.notesPassed).toContain("docker pull ghcr.io/jsonbored/gittensory-selfhost:orb-v0.2.0");
    expect(r.notesPassed).not.toContain("What's Changed");
    expect(r.calls).not.toContain("gh api");
  });

  it("falls back to a compare-link note instead of a changelog that would exceed GitHub's release-body limit", () => {
    const harness = createHarness({
      tagList: ["orb-v0.2.0", "orb-v0.1.0"],
      changelogBody: "x".repeat(121000),
    });
    const r = harness.run();
    expect(r.status).toBe(0);
    expect(r.notesPassed).not.toContain("xxxx");
    expect(r.notesPassed).toContain("Changelog omitted");
    expect(r.notesPassed).toContain("https://github.com/JSONbored/gittensory/compare/orb-v0.1.0...orb-v0.2.0");
    expect(r.notesPassed.length).toBeLessThan(121000);
    // The fallback must not drop the operator-critical pull command along with the oversized changelog.
    expect(r.notesPassed).toContain("docker pull ghcr.io/jsonbored/gittensory-selfhost:orb-v0.2.0");
  });

  it("uses release create when the release does not exist yet, and release edit when it does", () => {
    const notYetReleased = createHarness({ tagList: ["orb-v0.2.0", "orb-v0.1.0"], changelogBody: "notes", releaseExists: false });
    const r1 = notYetReleased.run();
    expect(r1.calls).toContain("gh release create orb-v0.2.0");
    expect(r1.calls).not.toContain("gh release edit");

    const alreadyReleased = createHarness({ tagList: ["orb-v0.2.0", "orb-v0.1.0"], changelogBody: "notes", releaseExists: true });
    const r2 = alreadyReleased.run();
    expect(r2.calls).toContain("gh release edit orb-v0.2.0");
    expect(r2.calls).not.toContain("gh release create");
  });

  it("still publishes with the plain notes if the generate-notes API call itself fails", () => {
    const harness = createHarness({ tagList: ["orb-v0.2.0", "orb-v0.1.0"] }); // changelogBody omitted -> API call exits 1
    const r = harness.run();
    expect(r.status).toBe(0);
    expect(r.notesPassed).toContain("docker pull ghcr.io/jsonbored/gittensory-selfhost:orb-v0.2.0");
    // A silent empty changelog would be indistinguishable from a genuinely empty PR range -- the run
    // log must say the API call itself failed.
    expect(r.stdout).toContain("::warning::Fetching the release changelog");
  });
});
