// Repo-doc PR delivery (#3000/#3004, part of the repo-doc generation roadmap #2993). Turns a rendered AGENTS.md
// body (src/review/repo-doc-render.ts, itself derived from src/review/repo-profile.ts) into an actual pull
// request against the target repo -- branch + commit + PR-open, reusing the SAME installation-token write
// chokepoint (makeInstallationOctokit) every other GitHub write in this engine goes through. Never a direct
// commit to the target repo's default branch: AGENTS.md and CLAUDE.md are always delivered as a PR.
//
// DIFF-AWARE REFRESH (#3004): before building anything, the CURRENT AGENTS.md on the default branch (if any) is
// fetched and run through src/review/generated-doc-refresh.ts's marker-block refresh. That call is the single
// source of truth for what happens next -- a first-run repo gets the full generated content, a repo whose
// generated section is unchanged gets NO pull request at all (no-op), a repo whose generated section changed
// gets a pull request with everything outside the markers preserved byte-for-byte, and a repo whose marker
// block is missing or malformed gets neither a silent overwrite nor a guess -- just a reported reason.
//
// CONFIG-AS-CODE GATE (#3002): this whole feature is opt-in per repo via `.gittensory.yml repoDocGeneration:`
// (src/signals/focus-manifest.ts) -- a manifest-only surface with no DB-backed counterpart, since there is no
// dashboard toggle for it. `enabled`/`scope` are checked BEFORE any profile extraction or GitHub call (the
// common case is disabled, so this must be cheap); `allowOverwriteExisting` is checked later, once refresh
// reports `manual-review-required` (the "this file looks hand-maintained" signal), and lets that specific case
// proceed as a fresh wholesale generate instead of skipping.
//
// SKILL FILE, ADDITIVE (#3001): when `.gittensory.yml repoDocGeneration.scope` includes `"skills"` AND the repo
// profile's contribution workflow warrants one (src/review/repo-skill-render.ts's shouldGenerateRepoSkill), a
// generated skill file rides along in the SAME commit/PR as AGENTS.md/CLAUDE.md -- there is no parallel
// delivery path. It gets its OWN marker pair and its own refreshGeneratedDoc call (reused unchanged, per that
// module's own design intent), so a skill-only content change can still open a PR even when AGENTS.md itself
// is unchanged, and a skill-file conflict (manual-review-required without the overwrite opt-in) only excludes
// the skill from this run rather than blocking the AGENTS.md refresh it rode in with.
import { githubErrorStatus, withInstallationTokenRetry } from "./app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "./client";
import { getRepository } from "../db/repositories";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { extractRepoProfile } from "../review/repo-profile";
import { REPO_DOC_MARKERS, renderRepoDocContent } from "../review/repo-doc-render";
import { REPO_SKILL_MARKERS, renderRepoSkillContent, repoSkillFilePath } from "../review/repo-skill-render";
import { refreshGeneratedDoc } from "../review/generated-doc-refresh";
import type { AgentActionMode } from "../settings/agent-execution";

/** Stable across runs (not per-run unique) so a repeat invocation targets the SAME branch/PR instead of piling up
 *  duplicates -- #3004's diff-aware refresh is expected to update commits on this same branch rather than open a
 *  second PR. #3000 itself only needs the "already an open PR on this branch" short-circuit below. */
const REPO_DOC_BRANCH_NAME = "gittensory/repo-docs";
const AGENTS_FILE_PATH = "AGENTS.md";
const CLAUDE_FILE_PATH = "CLAUDE.md";
const PR_TITLE = "docs: generate AGENTS.md and CLAUDE.md from repo profile";

export type RepoDocPullRequestResult =
  | { opened: true; reused: boolean; pullNumber: number; url: string; claudeMode: "symlink" | "copy" | "unknown" }
  | { opened: false; reason: string };

// Non-throwing split (mirrors repo-profile.ts's splitRepoFullName, not pr-actions.ts's throwing splitRepo):
// by the time this runs, `repoFullName` already named a row `getRepository` found, so re-validating its shape
// here would only guard against a state the DB's own invariants already rule out.
function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? { owner: "", repo: repoFullName } : { owner: repoFullName.slice(0, slash), repo: repoFullName.slice(slash + 1) };
}

type DocTreeEntry = { path: string; mode: "100644" | "120000"; type: "blob"; content: string };
type Octokit = ReturnType<typeof makeInstallationOctokit>;

// GitHub's Contents API base64-encodes the file's raw bytes (with line-wrapped whitespace); decoding through
// atob + TextDecoder (rather than a naive charCodeAt reassembly) is what makes this correct for non-ASCII
// manual content a maintainer added outside the generated markers.
function decodeGitHubFileContent(base64: string): string {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** The current content of `path` on `ref`, or `null` when it doesn't exist yet (first run). Any OTHER failure
 *  (rate limit, auth, a transient 5xx) is rethrown -- a repo we simply couldn't read must never be treated the
 *  same as a genuinely empty one, or a refresh could mistake "we don't know" for "there's nothing there yet".
 *  Shared by AGENTS.md and the (optional) skill file -- both are "does this file exist, and what's in it"
 *  probes against the same Contents API, differing only in path. */
async function fetchExistingFileContent(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref });
    const data = response.data as { content?: string };
    return typeof data.content === "string" ? decodeGitHubFileContent(data.content) : null;
  } catch (error) {
    if (githubErrorStatus(error) === 404) return null;
    throw error;
  }
}

/** Builds the AGENTS.md + CLAUDE.md tree (plus any `extraEntries`, e.g. a generated skill file, #3001) atop the
 *  branch's current tree in ONE commit, so first-run (paths absent) and refresh (paths present) are handled
 *  identically -- `base_tree` + explicit per-path entries add-or-replace regardless of whether the path
 *  previously existed, with no separate "does it exist yet" probe. Tries a real symlink (git mode 120000) for
 *  CLAUDE.md first; if the target repo/platform rejects that tree, retries with CLAUDE.md as a byte-identical
 *  regular-file copy of AGENTS.md instead (#3000's own documented fallback) -- `extraEntries` ride along in
 *  BOTH attempts unchanged, since the symlink fallback is only ever about CLAUDE.md's own tree entry. */
async function buildRepoDocTree(octokit: Octokit, owner: string, repo: string, baseTreeSha: string, agentsContent: string, extraEntries: DocTreeEntry[] = []): Promise<{ treeSha: string; claudeMode: "symlink" | "copy" }> {
  const agentsEntry: DocTreeEntry = { path: AGENTS_FILE_PATH, mode: "100644", type: "blob", content: agentsContent };
  try {
    const symlinkEntry: DocTreeEntry = { path: CLAUDE_FILE_PATH, mode: "120000", type: "blob", content: AGENTS_FILE_PATH };
    const response = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseTreeSha, tree: [agentsEntry, symlinkEntry, ...extraEntries] });
    return { treeSha: (response.data as { sha: string }).sha, claudeMode: "symlink" };
  } catch {
    const copyEntry: DocTreeEntry = { path: CLAUDE_FILE_PATH, mode: "100644", type: "blob", content: agentsContent };
    const response = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseTreeSha, tree: [agentsEntry, copyEntry, ...extraEntries] });
    return { treeSha: (response.data as { sha: string }).sha, claudeMode: "copy" };
  }
}

function repoDocPullRequestBody(repoFullName: string, skillPath: string | null): string {
  const skillParagraph = skillPath
    ? `\n\nThis repo's contribution workflow has enough structure (a blocking gate check, a strict linked-issue rule, and/or multi-stage CI) that it also gets a generated skill file at \`${skillPath}\`, following this project's own \`.claude/skills/\` convention -- a frontmatter description plus a procedural body.`
    : "";
  return `Gittensory opened this pull request on the maintainer's behalf. This is an automated maintenance action, not a manual code review.

## What this is

\`AGENTS.md\`, generated from a profile of ${repoFullName}'s own code -- its indexed file layout, naming and test-file conventions, build/test/lint commands, and contribution-workflow settings (whether CI publishes a required check, the linked-issue policy, and indexed CI workflow files). \`CLAUDE.md\` is kept in sync with it (as a symlink where the platform supports one, otherwise an identical copy), so the two never drift apart.${skillParagraph}

## Why it looks like this

Every fact above was read directly from this repository, not templated or guessed. If something looks wrong, it most likely means the underlying signal doesn't represent this repo well -- edit the generated file directly on this branch (or after merging) rather than filing an issue against Gittensory.

## Opting out

Set \`repoDocGeneration.enabled: false\` in this repository's \`.gittensory.yml\` (or simply close this pull request) -- no further action is taken until it is re-enabled.
`;
}

/**
 * Generate AGENTS.md/CLAUDE.md (and, when warranted and in scope, a skill file -- #3001) from this repo's
 * profile and open (or find the already-open) pull request carrying them. Returns `{ opened: false, reason }`
 * -- never throws -- when: the repo isn't installed, the repo profile has no data yet (#2999's fail-closed
 * branch), `mode` is not `"live"` (dry-run/paused instances must not chain several dependent GitHub writes
 * through synthetic suppressed responses -- see `maybeEscalateModeration` in `agent-action-executor.ts` for the
 * same "no side effect for a write that didn't really happen" guard on a different action), the diff-aware
 * refresh (#3004) found nothing meaningful to change in EITHER AGENTS.md or the skill file, AGENTS.md's own
 * marker block is missing/malformed (fails closed rather than guessing), or any step failed partway through.
 * The ENTIRE body runs inside one try/catch (not just the GitHub-write chain) so a failure in the repo/profile
 * lookups themselves is reported the same honest way, rather than propagating as an uncaught exception from
 * what the rest of the engine treats as a fail-safe call.
 */
export async function openRepoDocPullRequest(env: Env, repoFullName: string, mode: AgentActionMode): Promise<RepoDocPullRequestResult> {
  try {
    const repository = await getRepository(env, repoFullName);
    if (!repository?.installationId) return { opened: false, reason: "repository is not installed" };

    const manifest = await loadRepoFocusManifest(env, repoFullName);
    if (!manifest.repoDocGeneration.enabled) return { opened: false, reason: "repo-doc generation is not enabled for this repository (.gittensory.yml repoDocGeneration.enabled)" };
    if (!manifest.repoDocGeneration.scope.includes("agents")) return { opened: false, reason: 'repo-doc generation scope does not include "agents" for this repository (.gittensory.yml repoDocGeneration.scope)' };

    const profile = await extractRepoProfile(env, repoFullName);
    if (!profile.present) return { opened: false, reason: profile.reason };
    const generatedSection = renderRepoDocContent(profile);
    if (!generatedSection) return { opened: false, reason: "no content rendered from profile" };

    if (mode !== "live") return { opened: false, reason: `repo-doc pull request not opened: action mode is "${mode}"` };

    const { owner, repo } = splitRepo(repoFullName);
    const installationId = repository.installationId;
    return await withInstallationTokenRetry(env, installationId, async (token) => {
      const octokit = makeInstallationOctokit(env, token, mode, githubRateLimitAdmissionKeyForInstallation(installationId));

      const baseBranch = repository.defaultBranch ?? (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo })).data.default_branch;

      const existingOpenPrs = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "open", head: `${owner}:${REPO_DOC_BRANCH_NAME}`, base: baseBranch });
      const existing = (existingOpenPrs.data as Array<{ number: number; html_url: string }>)[0];
      // "unknown", not "symlink": this short-circuit deliberately avoids a further tree/contents lookup (the
      // whole point of reusing the existing PR instead of rebuilding it), so there is no real signal here for
      // whether ITS CLAUDE.md landed as a symlink or the copy fallback (buildRepoDocTree only reports that for
      // a tree IT just built). Reporting "symlink" unconditionally would misrepresent every reused PR that
      // actually fell back to a copy.
      if (existing) return { opened: true, reused: true, pullNumber: existing.number, url: existing.html_url, claudeMode: "unknown" };

      const currentAgentsContent = await fetchExistingFileContent(octokit, owner, repo, AGENTS_FILE_PATH, baseBranch);
      let refresh = refreshGeneratedDoc(currentAgentsContent, generatedSection, REPO_DOC_MARKERS);
      if (refresh.action === "manual-review-required") {
        // "manual-review-required" is generated-doc-refresh.ts's proxy for "this file looks hand-maintained,
        // not machine-generated" (no recognizable marker block). #3002's allowOverwriteExisting is the explicit
        // opt-in required before that content is discarded in favor of a fresh generate -- without it, stay
        // skipped exactly as #3004 already behaves.
        if (!manifest.repoDocGeneration.allowOverwriteExisting) return { opened: false, reason: `AGENTS.md needs manual review before it can be refreshed: ${refresh.reason}` };
        refresh = { action: "generate", content: generatedSection };
      }
      const agentsChanged = refresh.action !== "no-change";
      // refreshGeneratedDoc never returns "no-change" for a null currentContent (that's always "generate"), so
      // currentAgentsContent is guaranteed non-null here.
      const agentsContent = refresh.action === "no-change" ? currentAgentsContent! : refresh.content;

      // Skill file (#3001): additive to this SAME pull request, never a parallel delivery path. A skill-only
      // change can still open a PR even when AGENTS.md itself is unchanged; a skill-file conflict only excludes
      // the skill from THIS run (agentsChanged is unaffected), it never blocks the AGENTS.md refresh.
      let skillEntry: { path: string; content: string } | null = null;
      if (manifest.repoDocGeneration.scope.includes("skills")) {
        const generatedSkillSection = renderRepoSkillContent(profile);
        if (generatedSkillSection) {
          const skillPath = repoSkillFilePath(repoFullName);
          const currentSkillContent = await fetchExistingFileContent(octokit, owner, repo, skillPath, baseBranch);
          let skillRefresh = refreshGeneratedDoc(currentSkillContent, generatedSkillSection, REPO_SKILL_MARKERS);
          if (skillRefresh.action === "manual-review-required" && manifest.repoDocGeneration.allowOverwriteExisting) {
            skillRefresh = { action: "generate", content: generatedSkillSection };
          }
          if (skillRefresh.action === "replace" || skillRefresh.action === "generate") skillEntry = { path: skillPath, content: skillRefresh.content };
        }
      }

      if (!agentsChanged && !skillEntry) return { opened: false, reason: "no meaningful change since the last generated AGENTS.md" };

      const branchInfo = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch: baseBranch });
      const baseCommitSha = branchInfo.data.commit.sha;
      const baseTreeSha = branchInfo.data.commit.commit.tree.sha;

      const extraEntries: DocTreeEntry[] = skillEntry ? [{ path: skillEntry.path, mode: "100644", type: "blob", content: skillEntry.content }] : [];
      const { treeSha, claudeMode } = await buildRepoDocTree(octokit, owner, repo, baseTreeSha, agentsContent, extraEntries);

      const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: PR_TITLE, tree: treeSha, parents: [baseCommitSha] });
      const commitSha = (commit.data as { sha: string }).sha;

      await octokit.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/heads/${REPO_DOC_BRANCH_NAME}`, sha: commitSha });

      const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title: PR_TITLE,
        body: repoDocPullRequestBody(repoFullName, skillEntry?.path ?? null),
        head: REPO_DOC_BRANCH_NAME,
        base: baseBranch,
        maintainer_can_modify: true,
      });
      const prData = pr.data as { number: number; html_url: string };
      return { opened: true, reused: false, pullNumber: prData.number, url: prData.html_url, claudeMode };
    });
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : "unknown error opening repo-doc pull request" };
  }
}
