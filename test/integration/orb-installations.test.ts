import { describe, expect, it } from "vitest";
import { upsertOrbInstallation } from "../../src/orb/installations";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const created = (id: number) => ({ action: "created", installation: { id, account: { login: "acme", type: "Organization" }, repository_selection: "selected" } });
const get = (e: Env, id: number) =>
  (e.DB as unknown as TestD1Database)
    .prepare("SELECT account_login, account_type, repository_selection, registered, suspended_at, removed_at FROM orb_github_installations WHERE installation_id=?")
    .bind(id)
    .first<{ account_login: string; account_type: string; repository_selection: string; registered: number; suspended_at: string | null; removed_at: string | null }>();

describe("upsertOrbInstallation", () => {
  it("'created' registers the install (registered=0 — the manual-onboarding gate)", async () => {
    const e = createTestEnv();
    await upsertOrbInstallation(e, "installation", created(100));
    expect(await get(e, 100)).toMatchObject({ account_login: "acme", account_type: "Organization", repository_selection: "selected", registered: 0, suspended_at: null, removed_at: null });
  });

  it("'created' with a minimal installation stores null account/type/selection", async () => {
    const e = createTestEnv();
    await upsertOrbInstallation(e, "installation", { action: "created", installation: { id: 300 } });
    expect(await get(e, 300)).toMatchObject({ account_login: null, account_type: null, repository_selection: null, registered: 0 });
  });

  it("'suspend' then 'unsuspend' toggle suspended_at", async () => {
    const e = createTestEnv();
    await upsertOrbInstallation(e, "installation", created(101));
    await upsertOrbInstallation(e, "installation", { action: "suspend", installation: { id: 101 } });
    expect((await get(e, 101))?.suspended_at).not.toBeNull();
    await upsertOrbInstallation(e, "installation", { action: "unsuspend", installation: { id: 101 } });
    expect((await get(e, 101))?.suspended_at).toBeNull();
  });

  it("'deleted' sets removed_at; 'new_permissions_accepted' re-activates (clears removed_at)", async () => {
    const e = createTestEnv();
    await upsertOrbInstallation(e, "installation", created(102));
    await upsertOrbInstallation(e, "installation", { action: "deleted", installation: { id: 102 } });
    expect((await get(e, 102))?.removed_at).not.toBeNull();
    await upsertOrbInstallation(e, "installation", { action: "new_permissions_accepted", installation: { id: 102, account: { login: "acme", type: "Organization" }, repository_selection: "all" } });
    const row = await get(e, 102);
    expect(row?.removed_at).toBeNull();
    expect(row?.repository_selection).toBe("all");
  });

  it("does nothing for a non-installation event, a missing installation id, or an unknown action", async () => {
    const e = createTestEnv();
    await upsertOrbInstallation(e, "pull_request", created(200)); // wrong event
    await upsertOrbInstallation(e, "installation", { action: "created" }); // no installation object
    await upsertOrbInstallation(e, "installation", { action: "created", installation: { id: 0 } }); // falsy id
    expect(await get(e, 200)).toBeFalsy(); // never inserted
    const e2 = createTestEnv();
    await upsertOrbInstallation(e2, "installation", created(201));
    await upsertOrbInstallation(e2, "installation", { action: "labeled", installation: { id: 201 } }); // unknown action → no change
    expect((await get(e2, 201))?.removed_at).toBeNull();
  });
});
