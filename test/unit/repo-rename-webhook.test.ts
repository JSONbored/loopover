import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/job-dispatch";
import { resolveRepositoryIdentityPredecessor } from "../../src/queue/processors";
import { getPullRequest, getRepository, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function seedInstalledRepo(env: Env, fullName: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    action: "created",
    installation: { id: installationId, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
  });
  await upsertRepositoryFromGitHub(env, { name: fullName.split("/")[1]!, full_name: fullName, private: false, owner: { login: "owner" } }, installationId);
}

function renamedWebhookPayload(fromName: string, toFullName: string, installationId: number) {
  return {
    action: "renamed",
    changes: { repository: { name: { from: fromName } } },
    repository: { name: toFullName.split("/")[1]!, full_name: toFullName, private: false, owner: { login: "owner" } },
    installation: { id: installationId, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
    sender: { login: "owner", type: "User" },
  };
}

describe("repository renamed webhook", () => {
  it("REGRESSION (#repo-rename-migration): a repository/renamed webhook migrates PR history forward instead of creating a disconnected duplicate repo", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9700);
    await upsertPullRequestFromGitHub(env, "owner/gittensory", { number: 1, title: "Pre-rename PR", state: "open", labels: [] });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-1",
      eventName: "repository",
      payload: renamedWebhookPayload("gittensory", "owner/loopover", 9700) as never,
    });

    expect(await getRepository(env, "owner/gittensory")).toBeNull();
    const renamed = await getRepository(env, "owner/loopover");
    expect(renamed?.installationId).toBe(9700);
    const migratedPr = await getPullRequest(env, "owner/loopover", 1);
    expect(migratedPr?.title).toBe("Pre-rename PR");
  }, 30_000);

  it("records a github_app.repository_renamed audit event with the old and new names", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9701);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-2",
      eventName: "repository",
      payload: renamedWebhookPayload("gittensory", "owner/loopover", 9701) as never,
    });

    const row = await env.DB.prepare("select target_key, detail from audit_events where event_type = 'github_app.repository_renamed'").first<{
      target_key: string;
      detail: string;
    }>();
    expect(row?.target_key).toBe("owner/loopover");
    expect(row?.detail).toContain("owner/gittensory");
    expect(row?.detail).toContain("owner/loopover");
  }, 30_000);

  it("does not migrate anything for a repository webhook with a different action (e.g. created)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9702);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "not-a-rename",
      eventName: "repository",
      payload: { action: "created", repository: { name: "gittensory", full_name: "owner/gittensory", private: false, owner: { login: "owner" } }, installation: { id: 9702, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] } } as never,
    });

    expect(await getRepository(env, "owner/gittensory")).not.toBeNull();
  }, 30_000);

  it("does not crash and does not migrate when the payload is missing the old-name field (a sparse/unexpected renamed payload)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9703);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "rename-missing-from",
        eventName: "repository",
        payload: { action: "renamed", repository: { name: "loopover", full_name: "owner/loopover", private: false, owner: { login: "owner" } }, installation: { id: 9703, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] } } as never,
      }),
    ).resolves.toBeUndefined();

    // No migration happened (nothing to migrate from), but the normal upsert still records the current repo state.
    expect(await getRepository(env, "owner/gittensory")).not.toBeNull();
  }, 30_000);

  it("is a safe no-op when the computed old and new full names are identical (e.g. a case-only GitHub-side rename with nothing to migrate)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/loopover", 9704);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-same-name",
      eventName: "repository",
      payload: renamedWebhookPayload("loopover", "owner/loopover", 9704) as never,
    });

    const renamed = await getRepository(env, "owner/loopover");
    expect(renamed?.installationId).toBe(9704);
  }, 30_000);
});

// #9056: `repository.transferred` was never handled even though it was already listed in
// WEBHOOK_METRIC_ACTIONS, so the case was anticipated and simply never implemented. `repositories` is keyed by
// full_name with no github_id, so a transfer just INSERTed a fresh row and orphaned every table
// renameRepositoryIdentity migrates — including repository_settings, meaning autonomy and gate config silently
// reverted to defaults while the repo kept operating, and staged approvals in agent_pending_actions were lost.
describe("repository transferred webhook (#9056)", () => {
  function transferredWebhookPayload(fromOwner: string, toFullName: string, installationId: number, ownerKind: "organization" | "user" = "organization") {
    return {
      action: "transferred",
      // A transfer changes the OWNER and keeps the name — the inverse of a rename.
      changes: { owner: { from: { [ownerKind]: { login: fromOwner } } } },
      repository: { name: toFullName.split("/")[1]!, full_name: toFullName, private: false, owner: { login: toFullName.split("/")[0]! } },
      installation: { id: installationId, account: { login: toFullName.split("/")[0]!, id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
      sender: { login: "owner", type: "User" },
    };
  }

  it("migrates PR history forward on a transfer instead of orphaning it under the old owner", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "old-org/widgets", 9800);
    await upsertPullRequestFromGitHub(env, "old-org/widgets", { number: 4, title: "Pre-transfer PR", state: "open", labels: [] });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "repo-transferred",
      eventName: "repository",
      payload: transferredWebhookPayload("old-org", "new-org/widgets", 9800),
    } as never);

    expect(await getPullRequest(env, "new-org/widgets", 4)).toMatchObject({ title: "Pre-transfer PR" });
    expect(await getRepository(env, "new-org/widgets")).toBeTruthy();
  });

  it("derives the previous owner from a USER-owned transfer too (changes.owner.from.user)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "alice/widgets", 9801);
    await upsertPullRequestFromGitHub(env, "alice/widgets", { number: 5, title: "User-owned PR", state: "open", labels: [] });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "repo-transferred-user",
      eventName: "repository",
      payload: transferredWebhookPayload("alice", "new-org/widgets", 9801, "user"),
    } as never);

    expect(await getPullRequest(env, "new-org/widgets", 5)).toMatchObject({ title: "User-owned PR" });
  });

  it("is a no-op when the previous owner cannot be derived (no changes.owner) — never guesses an identity", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "old-org/widgets", 9802);
    await upsertPullRequestFromGitHub(env, "old-org/widgets", { number: 6, title: "Untouched", state: "open", labels: [] });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "repo-transferred-no-changes",
      eventName: "repository",
      payload: {
        action: "transferred",
        repository: { name: "widgets", full_name: "new-org/widgets", private: false, owner: { login: "new-org" } },
        installation: { id: 9802, account: { login: "new-org", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
      },
    } as never);

    // The original row is left exactly where it was rather than being migrated to a guessed name.
    expect(await getPullRequest(env, "old-org/widgets", 6)).toMatchObject({ title: "Untouched" });
  });
});

// #9056: the pure predecessor resolver, tested directly. The live pipeline cannot reach several of these
// shapes (the repository upsert alongside this handler requires a full_name and fails first), which is
// exactly why the logic is extracted rather than left inline.
describe("resolveRepositoryIdentityPredecessor (#9056)", () => {
  it("derives a TRANSFER's old name from the previous org or user owner, keeping the repo name", () => {
    expect(resolveRepositoryIdentityPredecessor("transferred", "new-org/widgets", { owner: { from: { organization: { login: "old-org" } } } })).toBe("old-org/widgets");
    expect(resolveRepositoryIdentityPredecessor("transferred", "new-org/widgets", { owner: { from: { user: { login: "alice" } } } })).toBe("alice/widgets");
  });

  it("derives a RENAME's old name from the previous repo name, keeping the owner", () => {
    expect(resolveRepositoryIdentityPredecessor("renamed", "owner/loopover", { repository: { name: { from: "gittensory" } } })).toBe("owner/gittensory");
  });

  it("returns undefined when the predecessor cannot be determined — never guesses an identity", () => {
    expect(resolveRepositoryIdentityPredecessor("transferred", "new-org/widgets", {})).toBeUndefined();
    expect(resolveRepositoryIdentityPredecessor("transferred", "new-org/widgets", undefined)).toBeUndefined();
    expect(resolveRepositoryIdentityPredecessor("renamed", "owner/loopover", {})).toBeUndefined();
    // No full_name ⇒ nothing to migrate toward.
    expect(resolveRepositoryIdentityPredecessor("transferred", undefined, { owner: { from: { organization: { login: "old-org" } } } })).toBeUndefined();
  });

  it("returns undefined when the result equals the current name — an idempotent redelivery is a no-op", () => {
    expect(resolveRepositoryIdentityPredecessor("transferred", "same-org/widgets", { owner: { from: { organization: { login: "same-org" } } } })).toBeUndefined();
    expect(resolveRepositoryIdentityPredecessor("renamed", "owner/widgets", { repository: { name: { from: "widgets" } } })).toBeUndefined();
  });
});
