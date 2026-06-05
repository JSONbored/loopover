import { describe, expect, it, vi } from "vitest";
import {
  parseRaycastRepoInput,
  runRaycastInstallHealthCommand,
  runRaycastMaintainerQueueCommand,
  runRaycastPublicPreviewCommand,
  type RaycastApiClient,
  type RaycastCommandFetch,
} from "../../src/raycast/maintainer-commands";

const TOKEN = `gts_${"b".repeat(64)}`;

describe("Raycast maintainer commands", () => {
  it("normalizes repo picker/input values from owner/repo and GitHub URLs", () => {
    expect(parseRaycastRepoInput("JSONbored/gittensory")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
      repoFullName: "JSONbored/gittensory",
    });
    expect(parseRaycastRepoInput("https://github.com/JSONbored/gittensory/pulls")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
      repoFullName: "JSONbored/gittensory",
    });
    expect(parseRaycastRepoInput("JSONbored/gittensory.git")).toEqual({
      owner: "JSONbored",
      repo: "gittensory",
      repoFullName: "JSONbored/gittensory",
    });
    expect(() => parseRaycastRepoInput("not a repo")).toThrow(/owner\/repo/i);
  });

  it("builds the maintainer queue command from mocked API intelligence, settings, and install health", async () => {
    const { client, calls } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": {
        generatedAt: "2026-06-04T08:00:00.000Z",
        repo: { fullName: "JSONbored/gittensory", installationId: 123 },
        queueHealth: {
          level: "medium",
          signals: { openPullRequests: 4, openIssues: 8, likelyReviewablePullRequests: 2 },
        },
        maintainerLane: { status: "ready" },
        maintainerCutReadiness: { level: "watch" },
        contributorIntakeHealth: { status: "healthy" },
        dataQuality: { warnings: ["Queue snapshot is 2h old."] },
      },
      "/v1/repos/JSONbored/gittensory/settings": {
        commentMode: "confirmed_miners",
        autoLabelEnabled: true,
        checkRunMode: "opt_in",
        publicSurface: "public_safe",
      },
      "/v1/installations/123/health": {
        status: "healthy",
        missingPermissions: [],
        missingEvents: [],
      },
    });

    const command = await runRaycastMaintainerQueueCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(command).toMatchObject({
      command: "maintainer_queue",
      repo: { repoFullName: "JSONbored/gittensory" },
      queue: {
        level: "medium",
        openPullRequests: 4,
        openIssues: 8,
        likelyReviewablePullRequests: 2,
        warnings: ["Queue snapshot is 2h old."],
      },
      installHealth: { status: "healthy", missingPermissions: [], missingEvents: [] },
      publicSurface: {
        commentMode: "confirmed_miners",
        labelMode: "configured",
        checkMode: "opt_in",
        publicSurface: "public_safe",
      },
      privacy: {
        sourceUpload: false,
        storesGitHubPat: false,
        githubMutations: false,
        publicPacketIncludesPrivateContext: false,
      },
    });
    expect(command.publicSurface.summary).toContain("Comments: confirmed_miners");
    expect(command.privateView.sections).toEqual([
      "Maintainer lane: ready",
      "Maintainer cut readiness: watch",
      "Contributor intake health: healthy",
    ]);
    expect(command.actions.every((action) => action.mutatesGitHub === false)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/repos/JSONbored/gittensory/intelligence",
      "/v1/repos/JSONbored/gittensory/settings",
      "/v1/installations/123/health",
    ]);
  });

  it("keeps queue command usable when settings are missing and no installation is linked", async () => {
    const { client, calls } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": {
        repo: { fullName: "JSONbored/gittensory" },
        queueHealth: {},
        maintainerLane: { note: "available without explicit status" },
      },
    });

    const command = await runRaycastMaintainerQueueCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(command.queue).toMatchObject({
      level: "unknown",
      openPullRequests: null,
      openIssues: null,
      likelyReviewablePullRequests: null,
      warnings: [],
    });
    expect(command.installHealth).toMatchObject({
      status: "not_installed",
      installationId: null,
    });
    expect(command.publicSurface).toMatchObject({
      commentMode: "unknown",
      labelMode: "configured",
      checkMode: "unknown",
      publicSurface: "confirmed-miner-only",
    });
    expect(command.privateView.sections).toEqual(["Maintainer lane: available"]);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/repos/JSONbored/gittensory/intelligence",
      "/v1/repos/JSONbored/gittensory/settings",
    ]);
  });

  it("reports disabled labels and unavailable install health without failing the queue command", async () => {
    const { client } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": {
        repo: { fullName: "JSONbored/gittensory", installationId: 789 },
        queueHealth: { level: "low", signals: {} },
      },
      "/v1/repos/JSONbored/gittensory/settings": {
        commentMode: "off",
        autoLabelEnabled: false,
        checkRunMode: "disabled",
      },
    });

    const command = await runRaycastMaintainerQueueCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(command.publicSurface).toMatchObject({
      commentMode: "off",
      labelMode: "disabled",
      checkMode: "disabled",
    });
    expect(command.installHealth).toMatchObject({
      status: "unavailable",
      installationId: 789,
      details: ["Installation health is unavailable from the current API response."],
    });
  });

  it("explains missing installation permissions for the install-health command", async () => {
    const { client } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": {
        repo: { fullName: "JSONbored/gittensory", installationId: 456 },
      },
      "/v1/installations/456/health": {
        status: "needs_attention",
        missingPermissions: ["issues:write", "checks:write"],
        missingEvents: ["pull_request"],
      },
    });

    const result = await runRaycastInstallHealthCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(result.installHealth).toMatchObject({
      status: "needs_attention",
      installationId: 456,
      missingPermissions: ["issues:write", "checks:write"],
      missingEvents: ["pull_request"],
    });
    expect(result.installHealth.details.join("\n")).toContain("Missing GitHub App permission: issues:write.");
    expect(result.installHealth.nextActions.join("\n")).toContain("Grant issues:write permission");
  });

  it("marks install health as not installed when repo intelligence has no installation id", async () => {
    const { client } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": { repo: { fullName: "JSONbored/gittensory" } },
    });

    const result = await runRaycastInstallHealthCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(result.installHealth).toMatchObject({
      status: "not_installed",
      installationId: null,
    });
  });

  it("marks install health as unavailable when the health endpoint is absent", async () => {
    const { client } = fakeRaycastClient({
      "/v1/repos/JSONbored/gittensory/intelligence": {
        repo: { fullName: "JSONbored/gittensory", installationId: 321 },
      },
    });

    const result = await runRaycastInstallHealthCommand({ client, repoInput: "JSONbored/gittensory" });

    expect(result.installHealth).toMatchObject({
      status: "unavailable",
      installationId: 321,
      nextActions: ["Refresh installation health, then retry the Raycast command."],
    });
  });

  it("runs public preview through the preview endpoint without posting, labels, checks, or source upload", async () => {
    const { client, calls } = fakeRaycastClient({
      "/v1/app/commands/preview": {
        preview: {
          body: "Checks are passing. Ready for review.",
          warnings: [],
          decision: {
            status: "ready",
            willComment: true,
            willLabel: false,
            willCheckRun: false,
          },
        },
      },
    });

    const result = await runRaycastPublicPreviewCommand({
      client,
      repoInput: "JSONbored/gittensory",
      pullNumber: 42,
      maintainerLogin: "jsonbored",
    });

    expect(result).toMatchObject({
      command: "public_preview",
      pullNumber: 42,
      body: "Checks are passing. Ready for review.",
      privacy: {
        previewOnly: true,
        sourceUpload: false,
        githubMutations: false,
        publicPacketIncludesPrivateContext: false,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/app/commands/preview" });
    expect(calls[0]?.body).toMatchObject({
      command: "@gittensory queue-summary",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 42,
      sample: { commenterLogin: "jsonbored", commenterAssociation: "OWNER" },
    });
    expect(calls.map((call) => call.path).join("\n")).not.toMatch(/comments|labels|check-runs|source/i);
  });

  it("rejects invalid preview pull numbers before making API requests", async () => {
    const { client, calls } = fakeRaycastClient({});

    await expect(
      runRaycastPublicPreviewCommand({
        client,
        repoInput: "JSONbored/gittensory",
        pullNumber: 0,
      }),
    ).rejects.toThrow(/positive pull request number/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces API errors cleanly for preview commands", async () => {
    const { client } = fakeRaycastClient({});

    await expect(
      runRaycastPublicPreviewCommand({
        client,
        repoInput: "JSONbored/gittensory",
        pullNumber: 1,
      }),
    ).rejects.toThrow("not_found");
  });

  it("does not copy private reviewability, score, wallet, or payout language into the public preview packet", async () => {
    const { client } = fakeRaycastClient({
      "/v1/app/commands/preview": {
        preview: {
          body: "private reviewability 91/100, wallet, hotkey, payout, reward estimate, and scoreability should not leak.",
          warnings: [],
          decision: { status: "ready", willComment: true },
        },
      },
    });

    const result = await runRaycastPublicPreviewCommand({
      client,
      repoInput: "JSONbored/gittensory",
      pullNumber: 7,
    });

    expect(result.body).not.toMatch(/private reviewability|wallet|hotkey|payout|reward estimate|scoreability/i);
    expect(result.privacy.publicPacketIncludesPrivateContext).toBe(false);
  });
});

function fakeRaycastClient(routes: Record<string, unknown>): {
  client: RaycastApiClient;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl: RaycastCommandFetch = vi.fn(async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, headers: init?.headers ?? {}, body });
    if (!(url.pathname in routes)) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, routes[url.pathname]);
  });
  return {
    client: {
      apiOrigin: "https://api.gittensory.test",
      sessionToken: TOKEN,
      fetchImpl,
    },
    calls,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not found",
    async json() {
      return body;
    },
  };
}
