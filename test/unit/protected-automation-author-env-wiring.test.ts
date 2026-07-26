import { afterEach, describe, expect, it, vi } from "vitest";

import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { derivePublicCommentMergeFacts, processJob } from "../../src/queue/processors";
import {
  maybeCloseDraftPr,
  maybeCloseRepeatedDraftCycling,
  maybeCloseReviewEvasionDraftConversion,
  maybeCloseReviewEvasionSelfClose,
  maybeCloseSynchronizeAmendment,
} from "../../src/queue/review-evasion";
import {
  isTrustedAutomationBotAuthor,
  isTrustedAutomationBotWebhookActor,
} from "../../src/settings/automation-bot-skip";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { GitHubWebhookPayload, PullRequestFileRecord, PullRequestRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #8645: PROTECTED_AUTOCLOSE_AUTHORS_EXTRA only worked in unit tests of isProtectedAutomationAuthor itself —
// every production caller dropped the env argument. These tests pin the end-to-end wiring at two of the four
// call-site families (contributor-cap early close + review-evasion), using an author that is ONLY protected
// via EXTRA (not in the built-in github-actions/dependabot/renovate set).

afterEach(() => vi.unstubAllGlobals());

const EXTRA_BOT = "mergify[bot]";

describe("PROTECTED_AUTOCLOSE_AUTHORS_EXTRA production wiring (#8645)", () => {
  it("automation-bot-skip helpers honor EXTRA when env is threaded through", () => {
    const env = createTestEnv({ PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: EXTRA_BOT });
    expect(isTrustedAutomationBotAuthor(EXTRA_BOT)).toBe(false);
    expect(isTrustedAutomationBotAuthor(EXTRA_BOT, env)).toBe(true);
    expect(isTrustedAutomationBotWebhookActor({ login: EXTRA_BOT, type: "Bot" }, EXTRA_BOT)).toBe(false);
    expect(isTrustedAutomationBotWebhookActor({ login: EXTRA_BOT, type: "Bot" }, EXTRA_BOT, env)).toBe(true);
  });

  it("derivePublicCommentMergeFacts marks an EXTRA-only bot neverClosed only when env is passed", () => {
    const env = createTestEnv({ PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: EXTRA_BOT });
    const base = {
      liveMergeState: "clean" as const,
      mergeableState: "clean",
      authorLogin: EXTRA_BOT,
      authorIsAdmin: false,
      liveCi: { ciState: "passed" as const, failingDetails: [], nonRequiredFailingDetails: [] },
      settings: {
        hardGuardrailGlobs: [],
        hardGuardrailGlobsOverridesInvariants: false,
        manualReviewLabel: undefined,
        closeOwnerAuthors: false,
      } as Pick<RepositorySettings, "hardGuardrailGlobs" | "hardGuardrailGlobsOverridesInvariants" | "manualReviewLabel" | "closeOwnerAuthors">,
      unifiedFiles: [{ path: "README.md" } as PullRequestFileRecord],
      repoFullName: "acme/widgets",
      prLabels: [] as string[],
    };
    expect(derivePublicCommentMergeFacts(base).neverClosed).toBe(false);
    expect(derivePublicCommentMergeFacts({ ...base, env }).neverClosed).toBe(true);
  });

  it("all five review-evasion guards: EXTRA-only bot early-returns (zero GitHub calls); without EXTRA the permission path is reached", async () => {
    // codecov/patch on #8742 flagged review-evasion.ts at 80% (1 partial) because only self-close was
    // exercised. Hit every production call site that gained the env argument so both outcomes of each
    // isProtectedAutomationAuthor(..., env) branch are covered.
    const evasionSettings = {
      reviewEvasionProtection: "on",
      autoCloseExemptLogins: [],
      draftPrClosePolicy: "close",
      synchronizeClosePolicy: "close",
    } as unknown as RepositorySettings;
    const pr = {
      repoFullName: "owner/repo",
      number: 7,
      title: "t",
      state: "open",
      isDraft: true,
      authorLogin: EXTRA_BOT,
      headSha: "abc123",
    } as PullRequestRecord;
    const payload = { sender: { login: EXTRA_BOT } } as GitHubWebhookPayload;

    const protectedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      protectedUrls.push(String(input instanceof Request ? input.url : input));
      return new Response("not found", { status: 404 });
    });
    const protectedEnv = createTestEnv({
      PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: EXTRA_BOT,
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    await maybeCloseReviewEvasionSelfClose(protectedEnv, "d-extra-1", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseReviewEvasionDraftConversion(protectedEnv, "d-extra-2", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseRepeatedDraftCycling(protectedEnv, "d-extra-3", 123, "owner/repo", pr, payload, evasionSettings, 2);
    await maybeCloseDraftPr(protectedEnv, "d-extra-4", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseSynchronizeAmendment(protectedEnv, "d-extra-5", 123, "owner/repo", pr, payload, evasionSettings);
    expect(protectedUrls).toEqual([]);

    vi.unstubAllGlobals();
    const unprotectedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      unprotectedUrls.push(String(input instanceof Request ? input.url : input));
      if (String(input).includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (String(input).includes("/collaborators/")) return Response.json({ permission: "read" });
      return new Response("not found", { status: 404 });
    });
    const unprotectedEnv = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await maybeCloseReviewEvasionSelfClose(unprotectedEnv, "d-no-1", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseReviewEvasionDraftConversion(unprotectedEnv, "d-no-2", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseRepeatedDraftCycling(unprotectedEnv, "d-no-3", 123, "owner/repo", pr, payload, evasionSettings, 2);
    await maybeCloseDraftPr(unprotectedEnv, "d-no-4", 123, "owner/repo", pr, payload, evasionSettings);
    await maybeCloseSynchronizeAmendment(unprotectedEnv, "d-no-5", 123, "owner/repo", pr, payload, evasionSettings);
    // Without EXTRA the bot check no longer early-returns, so the maintainer-permission lookup runs.
    expect(unprotectedUrls.some((url) => url.includes("/collaborators/") || url.includes("/access_tokens"))).toBe(true);
  });

  it("maybeCloseForContributorCapOnOpen: EXTRA-only bot over a configured cap is NOT closed", async () => {
    // Disable the automation-bot-skip early-return so the contributor-cap short-circuit is the path under test —
    // that is the call site family that previously dropped env even when PROTECTED_AUTOCLOSE_AUTHORS_EXTRA was set.
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      PROTECTED_AUTOCLOSE_AUTHORS_EXTRA: EXTRA_BOT,
      LOOPOVER_SKIP_AUTOMATION_BOT_PRS: "false",
    });
    await upsertInstallation(env, {
      installation: {
        id: 123,
        account: { login: "JSONbored", id: 1, type: "User" },
        target_type: "User",
        repository_selection: "all",
        permissions: { metadata: "read", pull_requests: "write", issues: "write" },
        events: ["pull_request"],
      },
      repositories: [{ name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }],
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 53,
      title: "Bot PR one",
      state: "open",
      user: { login: EXTRA_BOT },
      head: { sha: "b53" },
      labels: [],
      body: "x",
    });
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 54,
      title: "Bot PR two",
      state: "open",
      user: { login: EXTRA_BOT },
      head: { sha: "b54" },
      labels: [],
      body: "y",
    });
    await upsertRepositorySettings(env, {
      repoFullName: "JSONbored/gittensory",
      autonomy: { close: "auto", label: "auto" },
    });
    await upsertRepoFocusManifest(
      env,
      "JSONbored/gittensory",
      {
        settings: {
          commentMode: "all_prs",
          publicSurface: "comment_only",
          checkRunMode: "off",
          contributorCapLabel: "spam-cap",
          reviewCheckMode: "required",
          aiReviewMode: "advisory",
          contributorOpenPrCap: 2,
          skipAutomationBotAuthors: "off",
        },
      },
      "repo_file",
    );

    const seen = { closed: false };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/pulls/55/files")) {
        return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+const ok = true;" }]);
      }
      if (url.includes("/pulls/55/reviews") || url.includes("/pulls/55/commits") || url.includes("/pulls/55/comments")) {
        return Response.json([]);
      }
      if ((url.endsWith("/pulls/53") || url.endsWith("/pulls/54")) && method === "GET") return Response.json({ state: "open" });
      if (url.endsWith("/pulls/55") && method === "PATCH") {
        seen.closed = JSON.parse(String(init?.body ?? "{}")).state === "closed";
        return Response.json({ number: 55, state: "closed" });
      }
      if (url.endsWith("/pulls/55")) {
        return Response.json({
          number: 55,
          state: "open",
          user: { login: EXTRA_BOT, type: "Bot" },
          head: { sha: "b55" },
          base: { ref: "main", sha: "base55" },
          mergeable_state: "clean",
          labels: [],
          body: "x",
        });
      }
      if (url.includes("/commits/b55/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/b55/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/commits/b55/check-suites")) return Response.json({ check_suites: [] });
      if (url.includes("/issues/55/labels")) return Response.json([]);
      if (url.includes("/issues/55/comments")) return Response.json([]);
      // Paginated list endpoints must return arrays — `{}` throws inside githubPaginatedList.
      if (url.includes("/pulls/") || url.includes("/issues/")) return Response.json([]);
      return Response.json({});
    });

    // The early-cap short-circuit is the path under test: when EXTRA wires through, the bot is exempt and
    // maybeCloseForContributorCapOnOpen returns without closing. The webhook then continues into the rest of
    // the pipeline (which is out of scope here) — assert the close never fired regardless of later work.
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "extra-bot-cap-exempt",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        sender: { login: EXTRA_BOT, type: "Bot" },
        pull_request: {
          number: 55,
          title: "Bot's 3rd PR",
          state: "open",
          user: { login: EXTRA_BOT, type: "Bot" },
          head: { sha: "b55" },
          labels: [],
          body: "x",
          mergeable_state: "clean",
        },
      },
    }).catch(() => undefined);

    expect(seen.closed).toBe(false);
    const closeAudit = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'agent.action.close'").first<{ n: number }>();
    expect(closeAudit?.n ?? 0).toBe(0);
  });
});
