import { describe, expect, it } from "vitest";
import { getOrbGlobalStats, recordOrbPrOutcome } from "../../src/orb/outcomes";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

const db = (e: Env) => e.DB as unknown as TestD1Database;

const closedPr = (
  repo: string,
  number: number,
  mergedAt: string | null,
  installationId = 100,
  opts: { sender?: { login?: string; type?: string }; author?: string } = {},
) =>
  ({
    action: "closed",
    pull_request: { number, state: "closed", merged_at: mergedAt, ...(opts.author !== undefined ? { user: { login: opts.author } } : {}) },
    repository: { full_name: repo },
    installation: { id: installationId },
    ...(opts.sender !== undefined ? { sender: opts.sender } : {}),
  }) as never;

const registerInstall = (e: Env, id: number, registered: number) =>
  db(e).prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, ?)").bind(id, registered).run();

describe("recordOrbPrOutcome", () => {
  it("records a merged PR as outcome 'merged' (with the installation id)", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/widgets", 7, "2026-06-24T00:00:00Z"));
    const row = await db(e).prepare("SELECT outcome, installation_id FROM orb_pr_outcomes WHERE repository_full_name=? AND pr_number=?").bind("acme/widgets", 7).first<{ outcome: string; installation_id: number }>();
    expect(row).toMatchObject({ outcome: "merged", installation_id: 100 });
  });

  it("records a closed-not-merged PR as outcome 'closed'", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/widgets", 8, null));
    expect((await db(e).prepare("SELECT outcome FROM orb_pr_outcomes WHERE pr_number=8").first<{ outcome: string }>())?.outcome).toBe("closed");
  });

  it("is a no-op for a non-pull_request event, a non-closed action, or a missing pr/repo", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "installation", closedPr("a/b", 1, null)); // wrong event
    await recordOrbPrOutcome(e, "pull_request", { action: "opened", pull_request: { number: 2, state: "open", merged_at: null }, repository: { full_name: "a/b" } } as never); // not closed
    await recordOrbPrOutcome(e, "pull_request", { action: "closed", repository: { full_name: "a/b" } } as never); // no pr
    await recordOrbPrOutcome(e, "pull_request", { action: "closed", pull_request: { number: 3, state: "closed", merged_at: null } } as never); // no repo
    expect((await db(e).prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(0);
  });

  it("overwrites the terminal state on a re-close (idempotent on repo + pr)", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/widgets", 9, null)); // closed
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/widgets", 9, "2026-06-24T01:00:00Z")); // reopened → merged
    expect((await db(e).prepare("SELECT outcome FROM orb_pr_outcomes WHERE pr_number=9").first<{ outcome: string }>())?.outcome).toBe("merged");
  });

  it("does NOT record a contributor self-close (sender === author, unmerged) and never overwrites a prior row", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/self", 20, null, 100, { sender: { login: "alice" }, author: "alice" }));
    expect((await db(e).prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes WHERE pr_number=20").first<{ n: number }>())?.n).toBe(0);
    // A later self-close must not OVERWRITE a prior authoritative (maintainer) row.
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/self", 20, null, 100, { sender: { login: "maintainer" }, author: "alice" })); // maintainer close → recorded
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/self", 20, null, 100, { sender: { login: "alice" }, author: "alice" })); // self-close → ignored
    expect((await db(e).prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes WHERE pr_number=20").first<{ n: number }>())?.n).toBe(1);
  });

  it("DOES record a maintainer close, a bot-actor close, and a close with no author (non-self / authoritative)", async () => {
    const e = createTestEnv();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/maint", 21, null, 100, { sender: { login: "maintainer" }, author: "alice" })); // sender != author
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/bot", 22, null, 100, { sender: { login: "x[bot]", type: "Bot" }, author: "x[bot]" })); // bot actor → recorded even when login matches
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/noauthor", 23, null, 100, { sender: { login: "someone" } })); // no author field → not a self-close
    expect((await db(e).prepare("SELECT COUNT(*) AS n FROM orb_pr_outcomes").first<{ n: number }>())?.n).toBe(3);
  });
});

describe("getOrbGlobalStats", () => {
  it("returns zeros on an empty/cold table (nullish SUM guard)", async () => {
    expect(await getOrbGlobalStats(createTestEnv())).toEqual({ merged: 0, closed: 0, total: 0 });
  });

  it("aggregates merged/closed across REGISTERED installations only", async () => {
    const e = createTestEnv();
    await registerInstall(e, 100, 1); // registered
    await registerInstall(e, 200, 0); // recorded but NOT opted in
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/a", 1, "2026-06-24T00:00:00Z", 100)); // merged, registered
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/b", 2, null, 100)); // closed, registered
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/c", 3, "2026-06-24T00:00:00Z", 200)); // merged, UNREGISTERED → excluded
    expect(await getOrbGlobalStats(e)).toEqual({ merged: 1, closed: 1, total: 2 });
  });

  it("excludeAccount drops an account already counted by another source (case-insensitive)", async () => {
    const e = createTestEnv();
    const db = e.DB as unknown as TestD1Database;
    await db.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (1, 'JSONbored', 1)").run();
    await db.prepare("INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (2, 'acme', 1)").run();
    await recordOrbPrOutcome(e, "pull_request", closedPr("jsonbored/x", 1, "2026-06-24T00:00:00Z", 1)); // JSONbored, merged
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/y", 2, null, 2)); // acme, closed
    expect(await getOrbGlobalStats(e, { excludeAccount: "jsonbored" })).toEqual({ merged: 0, closed: 1, total: 1 }); // JSONbored dropped
    expect(await getOrbGlobalStats(e)).toEqual({ merged: 1, closed: 1, total: 2 }); // no exclude → both
  });

  it("excludes a PR already counted by the own-ledger (published-surface audit event), but still counts an unrelated one", async () => {
    const e = createTestEnv();
    const db = e.DB as unknown as TestD1Database;
    await registerInstall(e, 100, 1);
    // acme/dup#1 was already published (and therefore counted) by the own-ledger disposition query.
    await db
      .prepare(
        "INSERT INTO audit_events (id, event_type, target_key, outcome, created_at) VALUES ('evt-1', 'github_app.pr_public_surface_published', 'acme/dup#1', 'success', '2026-06-24T00:00:00Z')",
      )
      .run();
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/dup", 1, "2026-06-24T00:00:00Z", 100)); // merged, already own-ledger-counted → must be excluded
    await recordOrbPrOutcome(e, "pull_request", closedPr("acme/new", 2, null, 100)); // closed, no own-ledger counterpart → must still count
    expect(await getOrbGlobalStats(e)).toEqual({ merged: 0, closed: 1, total: 1 });
  });
});
