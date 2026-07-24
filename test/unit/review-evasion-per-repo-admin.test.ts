import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maybeCloseDraftDodgeAttempt,
  maybeCloseReviewEvasionSelfClose,
  maybeRecloseDisallowedReopen,
} from "../../src/queue/review-evasion";
import { createTestEnv } from "../helpers/d1";
import type { GitHubWebhookPayload, PullRequestRecord, RepositorySettings } from "../../src/types";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #4889: the review-evasion guards' fleet-operator exemptions in per-repo admin mode. Mode OFF (self-host
// default) keeps the ADMIN_GITHUB_LOGINS shortcut byte-identical — an allowlisted actor is exempt with NO
// GitHub permission lookup. Mode ON drops that shortcut: the live per-repo collaborator permission is the
// sole non-owner permission source, so an allowlisted login with no real access on THIS repo stops being
// exempt. Each test pins which path ran by inspecting exactly which GitHub API calls the guard made.

const PEM_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_FOOTER = ["-----END", "PRIVATE KEY-----"].join(" ");

type StubHandler = (url: string) => Response | undefined;

function stubGitHub(handler: StubHandler = () => undefined): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
    const handled = handler(url);
    if (handled) return handled;
    return new Response("not found", { status: 404 });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

function pr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
    number: 7,
    title: "t",
    state: "closed",
    authorLogin: "fleetop",
    headSha: "abc123",
    ...overrides,
  } as PullRequestRecord;
}

const SETTINGS = { reviewEvasionProtection: "on", autoCloseExemptLogins: [] } as unknown as RepositorySettings;

function reopenPayload(sender: string): GitHubWebhookPayload {
  return { sender: { login: sender } } as GitHubWebhookPayload;
}

describe("maybeRecloseDisallowedReopen fleet-operator exemption (#4889)", () => {
  it("mode OFF: an allowlisted reopener is exempt via the allowlist alone — zero GitHub calls", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" });
    const urls = stubGitHub();
    const outcome = await maybeRecloseDisallowedReopen(env, "d1", 123, "owner/repo", pr(), reopenPayload("fleetop"));
    expect(outcome).toBe("allowed");
    expect(urls).toEqual([]);
  });

  it("mode OFF: the repo owner is exempt without a lookup regardless of the allowlist", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    const urls = stubGitHub();
    expect(await maybeRecloseDisallowedReopen(env, "d1", 123, "owner/repo", pr(), reopenPayload("owner"))).toBe("allowed");
    expect(urls).toEqual([]);
  });

  it("mode ON: the allowlist stops granting — the guard consults the live per-repo permission instead", async () => {
    const env = createTestEnv({
      ADMIN_GITHUB_LOGINS: "fleetop",
      LOOPOVER_PER_REPO_ADMIN: "true",
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    const urls = stubGitHub((url) => {
      if (url.includes("/collaborators/fleetop/permission")) return Response.json({ permission: "read" });
      // No qualifying closer on a fully-covered timeline → the reopen stays allowed after the deeper checks.
      if (url.includes("/timeline")) return Response.json([]);
      return undefined;
    });
    const outcome = await maybeRecloseDisallowedReopen(env, "d1", 123, "owner/repo", pr(), reopenPayload("fleetop"));
    expect(outcome).toBe("allowed");
    // The decisive difference from mode OFF: the live permission endpoint WAS consulted.
    expect(urls.some((url) => url.includes("/collaborators/fleetop/permission"))).toBe(true);
  });

  it("mode ON: the repo owner shortcut is untouched — still zero permission lookups", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop", LOOPOVER_PER_REPO_ADMIN: "true" });
    const urls = stubGitHub();
    expect(await maybeRecloseDisallowedReopen(env, "d1", 123, "owner/repo", pr(), reopenPayload("owner"))).toBe("allowed");
    expect(urls).toEqual([]);
  });
});

describe("maybeCloseReviewEvasionSelfClose fleet-operator exemption (#4889)", () => {
  it("mode OFF: an allowlisted self-closing author is maintainer-exempt with zero GitHub calls", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" });
    const urls = stubGitHub();
    await maybeCloseReviewEvasionSelfClose(env, "d1", 123, "owner/repo", pr(), reopenPayload("fleetop"), SETTINGS);
    expect(urls).toEqual([]);
  });

  it("mode ON: the allowlist stops granting — the live per-repo permission is consulted and a read-only author is no longer exempt", async () => {
    const env = createTestEnv({
      ADMIN_GITHUB_LOGINS: "fleetop",
      LOOPOVER_PER_REPO_ADMIN: "true",
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    });
    const urls = stubGitHub((url) => {
      if (url.includes("/collaborators/fleetop/permission")) return Response.json({ permission: "read" });
      return undefined;
    });
    // No review recorded for this headSha in the DB, so after the (now-failing) exemption the guard exits at
    // the has-reviewed gate — the observable difference is the permission lookup itself.
    await maybeCloseReviewEvasionSelfClose(env, "d1", 123, "owner/repo", pr(), reopenPayload("fleetop"), SETTINGS);
    expect(urls.some((url) => url.includes("/collaborators/fleetop/permission"))).toBe(true);
  });

  it("mode ON: the self-closing repo owner stays exempt without any lookup", async () => {
    const env = createTestEnv({ LOOPOVER_PER_REPO_ADMIN: "true" });
    const urls = stubGitHub();
    await maybeCloseReviewEvasionSelfClose(env, "d1", 123, "owner/repo", pr({ authorLogin: "owner" }), reopenPayload("owner"), SETTINGS);
    expect(urls).toEqual([]);
  });
});

describe("maybeCloseDraftDodgeAttempt fleet-operator exemption (#4889)", () => {
  it("computes the author's admin exemption through the mode-aware helper (allowlist in mode OFF), and skips it for an authorless PR", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" });
    const urls = stubGitHub();
    // No gate-block row exists in the DB, so the guard evaluates the exemptions and does nothing — no
    // comment, no close, no GitHub call in either case.
    await maybeCloseDraftDodgeAttempt(env, "d1", 123, "owner/repo", pr(), SETTINGS);
    await maybeCloseDraftDodgeAttempt(env, "d1", 123, "owner/repo", pr({ authorLogin: null }), SETTINGS);
    expect(urls).toEqual([]);
  });
});
