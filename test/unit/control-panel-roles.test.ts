import { describe, expect, it } from "vitest";
import { buildControlPanelRoleSummary, loadControlPanelRoleSummary } from "../../src/services/control-panel-roles";
import type { InstallationRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("control panel role summaries", () => {
  it("classifies miner, maintainer, owner, and operator roles from real repo state", () => {
    const summary = buildControlPanelRoleSummary({
      login: "oktofeesh1",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: true,
      operator: true,
      repositories: [
        repo("oktofeesh1/example", "oktofeesh1", 10),
        repo("entrius/allways-ui", "entrius", 11),
      ],
      installations: [installation(10, "oktofeesh1"), installation(11, "entrius")],
      pullRequests: [pull("entrius/allways-ui", "oktofeesh1", "COLLABORATOR")],
    });

    expect(summary.roles).toEqual(["miner", "maintainer", "owner", "operator"]);
    expect(summary.confirmedMiner).toBe(true);
    expect(summary.evidence).toMatchObject({
      ownedInstalledRepos: 1,
      maintainerRepos: 1,
      accountInstallations: 1,
      operator: true,
    });
    expect(summary.roleCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "miner", status: "active" }),
        expect.objectContaining({ role: "maintainer", status: "active", sampleRepos: expect.arrayContaining(["entrius/allways-ui", "oktofeesh1/example"]) }),
        expect.objectContaining({ role: "owner", status: "active", sampleRepos: ["oktofeesh1/example"] }),
        expect.objectContaining({ role: "operator", status: "active" }),
      ]),
    );
    expect(JSON.stringify(summary)).not.toMatch(/wallet|hotkey|raw trust|reward estimate|payout|farming|private reviewability|public score estimate/i);
  });

  it("keeps unknown users in onboarding without role fallbacks or sensitive details", () => {
    const summary = buildControlPanelRoleSummary({
      login: "new-user",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [repo("entrius/allways-ui", "entrius", 11)],
      installations: [installation(11, "entrius")],
      pullRequests: [pull("entrius/allways-ui", "new-user", "CONTRIBUTOR")],
    });

    expect(summary.roles).toEqual([]);
    expect(summary.onboarding.status).toBe("needs_setup");
    expect(summary.roleCards.every((card) => card.status === "needs_setup")).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/wallet|hotkey|raw trust|reward estimate|payout|farming|private reviewability|public score estimate/i);
  });

  it("redacts unsafe repository evidence strings before returning role cards", () => {
    const summary = buildControlPanelRoleSummary({
      login: "maintainer",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [repo("/Users/private github_pat_1234567890abcdef wallet hotkey", "maintainer", 12)],
      installations: [installation(12, "maintainer")],
      pullRequests: [],
    });

    expect(summary.roles).toEqual(["maintainer", "owner"]);
    expect(JSON.stringify(summary)).not.toMatch(/\/Users|github_pat|1234567890abcdef|wallet|hotkey/);
  });

  it("recognizes account installations even before an owned repo is cached", () => {
    const summary = buildControlPanelRoleSummary({
      login: "repo-owner",
      generatedAt: "2026-06-01T12:00:00.000Z",
      confirmedMiner: false,
      operator: false,
      repositories: [],
      installations: [installation(21, "repo-owner")],
      pullRequests: [],
    });

    expect(summary.roles).toEqual(["owner"]);
    expect(summary.roleCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "owner",
          status: "active",
          detail: "GitHub App account installation is linked to this login.",
          evidenceCount: 1,
        }),
      ]),
    );
  });

  it("keeps onboarding available when cached miner lookup fails", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    const originalPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: D1Database["prepare"] }).prepare = ((sql: string) => {
      if (sql.includes("official_miner_detections")) throw new Error("miner cache unavailable");
      return originalPrepare(sql);
    }) as D1Database["prepare"];

    await expect(loadControlPanelRoleSummary(env, "new-user")).resolves.toMatchObject({
      login: "new-user",
      roles: [],
      confirmedMiner: false,
      onboarding: { status: "needs_setup" },
      publicSafe: true,
    });
  });
});

function repo(fullName: string, owner: string, installationId: number): RepositoryRecord {
  return {
    fullName,
    owner,
    name: fullName.split("/").at(-1) ?? "repo",
    installationId,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
  };
}

function installation(id: number, accountLogin: string): InstallationRecord {
  return {
    id,
    accountLogin,
    accountId: id,
    targetType: "User",
    repositorySelection: "selected",
    permissions: {},
    events: [],
  };
}

function pull(repoFullName: string, authorLogin: string, authorAssociation: string): PullRequestRecord {
  return {
    repoFullName,
    number: 1,
    title: "Test PR",
    state: "open",
    authorLogin,
    authorAssociation,
    labels: [],
    linkedIssues: [],
  };
}
