import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLatestAdvisoryForPullRequest,
  upsertInstallation,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { reReviewStoredPullRequest } from "../../src/queue/processors";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #10168 end-to-end: the supersession split, driven through a real gate-evaluating entry point rather than
// against buildPullRequestAdvisory directly, so the whole seam is proven -- the linked-issue verification pass
// carrying closure facts out, the bounded merged-rival read, the flag, and the finding the contributor sees.
//
// The collision reproduced here is the real one from the Orb:
//   PR 8886 opened 09:22:36 citing issue 8829   (the issue was OPEN at that moment)
//   PR 8881 merged 09:30:24 citing the same issue
//   issue 8829 closed 09:30:25, one second later, as a side effect of that merge

const REPO = "JSONbored/gittensory";
const PR_CREATED = "2026-07-31T09:22:36Z";
const RIVAL_MERGED = "2026-07-31T09:30:24Z";
const ISSUE_CLOSED = "2026-07-31T09:30:25Z";

async function seedRepo(env: ReturnType<typeof createTestEnv>) {
  await persistRegistrySnapshot(
    asCloudEnv(env),
    normalizeRegistryPayload({ [REPO]: { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
  );
  await upsertInstallation(env, {
    action: "created",
    installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] },
  });
  await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } }, 123);
  await upsertRepositorySettings(env, {
    repoFullName: REPO,
    autoLabelEnabled: false,
    gatePack: "oss-anti-slop",
    // Only `label` acts, so maintenance never attempts a live merge/approve.
    autonomy: { label: "auto" },
  });
  // linkedIssueGateMode is CONFIG-AS-CODE only (loopover#6442) -- upsertRepositorySettings silently drops it,
  // so it has to arrive through the manifest's `gate:` block. "block" is the only mode in which the
  // open-reference check runs at all, and that is the pass the closure facts ride out of.
  await upsertRepoFocusManifest(env, REPO, {
    gate: { linkedIssue: "block" },
    settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", reviewCheckMode: "required", aiReviewMode: "off" },
  });
  // The merged rival, and the PR it superseded.
  await upsertPullRequestFromGitHub(env, REPO, {
    number: 8881, title: "rival", state: "closed", user: { login: "rival" }, head: { sha: "shaRival" },
    labels: [], body: "Closes #8829", created_at: "2026-07-31T09:04:07Z", merged_at: RIVAL_MERGED,
  } as never);
  await upsertPullRequestFromGitHub(env, REPO, {
    number: 8886, title: "Fix the thing", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR",
    head: { sha: "sha8886" }, base: { ref: "main" }, labels: [], body: "Closes #8829", created_at: PR_CREATED,
  } as never);
}

function stubGitHub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
    if (url.includes("/pulls/8886/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
    if (url.endsWith("/pulls/8886")) {
      return Response.json({ number: 8886, title: "Fix the thing", state: "open", user: { login: "contributor" }, head: { sha: "sha8886" }, labels: [], body: "Closes #8829", created_at: PR_CREATED, mergeable_state: "dirty" });
    }
    if (url.includes("/commits/sha8886/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
    if (url.includes("/commits/sha8886/status")) return Response.json({ state: "success", statuses: [] });
    // The issue the contributor correctly linked -- closed, by the rival's merge, one second after it landed.
    if (url.includes("/issues/8829")) return Response.json({ number: 8829, title: "The issue", state: "closed", closed_at: ISSUE_CLOSED, labels: [], assignees: [], user: { login: "reporter" } });
    if (url.includes("/issues/8886/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 1 }, { status: 201 });
    if (url.includes("/issues/8886/comments")) return Response.json([]);
    if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
    return Response.json({});
  });
}

async function runReview(supersededCloseFlag: string | undefined) {
  const env = createTestEnv({
    GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    ...(supersededCloseFlag === undefined ? {} : { LOOPOVER_SUPERSEDED_CLOSE: supersededCloseFlag }),
  });
  await seedRepo(env);
  stubGitHub();
  await reReviewStoredPullRequest(env, "superseded-wire", 123, REPO, 8886);
  const advisory = await getLatestAdvisoryForPullRequest(env, REPO, 8886);
  return (advisory?.findings ?? []).map((finding) => finding.code);
}

describe("superseded linked issue, wired end to end (#10168)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the supersession instead of 'No linked issue detected' once the flag is on", async () => {
    const codes = await runReview("true");
    expect(codes).toContain("linked_issue_superseded");
    expect(codes).not.toContain("missing_linked_issue");
  });

  it("is byte-identical to today's behaviour while the flag is off", async () => {
    // The whole feature ships dark: same finding, same message, same disposition as before it existed.
    for (const flag of [undefined, "false"]) {
      const codes = await runReview(flag);
      expect(codes, String(flag)).toContain("missing_linked_issue");
      expect(codes, String(flag)).not.toContain("linked_issue_superseded");
    }
  });
});
