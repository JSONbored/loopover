import { describe, expect, it, vi } from "vitest";
import { runPrCommandPrologue, type PrCommandPrologueDeps, type PrCommandPrologueSpec } from "../../src/queue/pr-command-prologue";

type Req = { ok: true; actor: string; repoFullName: string; installationId: number; pr: { number: number } };
type Auth = { authorized: boolean; reason: string; actorKind: string };

const OK_REQUEST: Req = { ok: true, actor: "maintainer", repoFullName: "o/r", installationId: 123, pr: { number: 7 } };

/** Every dep resolves the happy path; a test overrides only the one it is about. */
function deps(over: Partial<PrCommandPrologueDeps<Req, Auth>> = {}): PrCommandPrologueDeps<Req, Auth> {
  return {
    parseCommand: () => ({ name: "pause", raw: "@loopover pause" }) as never,
    classifyRequest: () => OK_REQUEST,
    hasSeenDelivery: async () => false,
    loadPullRequest: async () => ({ state: "open" }) as never,
    loadSettings: async () => ({}) as never,
    authorize: async () => ({ authorization: { authorized: true, reason: "", actorKind: "maintainer" } }),
    ...over,
  } satisfies PrCommandPrologueDeps<Req, Auth>;
}

function spec(over: Partial<PrCommandPrologueSpec> = {}): PrCommandPrologueSpec {
  return {
    commandName: "pause",
    completedEventType: "github_app.autoreview_paused",
    needsMinerDetection: true,
    recordSkip: async () => undefined,
    recordDenied: async () => undefined,
    ...over,
  };
}

const payload = { comment: { body: "@loopover pause" }, issue: { number: 7 } } as never;

// #9541: six handlers ran a byte-identical eleven-step prologue, copy-pasted 30 to 300 lines apart in a
// 16,000-line file. #9312 added the redelivery guard to five of them and missed `resolve`, which then wrote
// duplicate permanent suppression rows on every queue retry. These tests pin the sequence itself, so the next
// change to it is made once rather than six times.
describe("runPrCommandPrologue (#9541)", () => {
  it("returns `notMine` for another command's verb, so dispatch continues to the siblings", async () => {
    const outcome = await runPrCommandPrologue(payload, "d1", spec({ commandName: "resume" }), deps());
    expect(outcome.status).toBe("notMine");
  });

  it("returns `notMine` when the comment parses to no command at all", async () => {
    const outcome = await runPrCommandPrologue(payload, "d1", spec(), deps({ parseCommand: () => null }));
    expect(outcome.status).toBe("notMine");
  });

  it("INVARIANT: `notMine` and `handled` stay distinct — collapsing them would silently stop dispatch", async () => {
    // A handler returns false on notMine (keep dispatching) and true on handled (this was ours, it is done).
    // One falsy result for both is how a command stops reaching its siblings.
    const notMine = await runPrCommandPrologue(payload, "d1", spec({ commandName: "resume" }), deps());
    const handled = await runPrCommandPrologue(payload, "d1", spec(), deps({ hasSeenDelivery: async () => true }));
    expect(notMine.status).toBe("notMine");
    expect(handled.status).toBe("handled");
  });

  it("records the classifier's own reason and stops when the request is unclassifiable", async () => {
    const recordSkip = vi.fn(async () => undefined);
    const outcome = await runPrCommandPrologue(payload, "d1", spec({ recordSkip }), deps({
      classifyRequest: () => ({ ok: false, reason: "bot_author", repoFullName: "o/r", actor: "bot", targetKey: "o/r#7" }),
    }));
    expect(outcome.status).toBe("handled");
    expect(recordSkip).toHaveBeenCalledWith("bot_author", { repoFullName: "o/r", targetKey: "o/r#7", actor: "bot" });
  });

  it("INVARIANT: a classifier result with nothing populated still records a well-formed skip", async () => {
    // The not-ok arm's fields are all optional -- `missing_repo_pr_installation_or_actor` is precisely the
    // case where there is no repo, no target and no actor to report. The skip must still fire with explicit
    // nulls rather than throwing or recording `undefined`, since an operator reads these rows.
    const recordSkip = vi.fn(async () => undefined);
    const outcome = await runPrCommandPrologue(payload, "d1", spec({ recordSkip }), deps({ classifyRequest: () => ({ ok: false }) }));
    expect(outcome.status).toBe("handled");
    expect(recordSkip).toHaveBeenCalledWith("unclassified", { repoFullName: null, targetKey: null, actor: null });
  });

  it("REGRESSION: the redelivery guard runs BEFORE any load, so a replay costs no database reads", async () => {
    // The ordering is the point. Guarding after the loads still suppresses the duplicate WRITE, but pays for
    // the PR and settings reads on every retry of a storm.
    const loadPullRequest = vi.fn(async () => ({ state: "open" }) as never);
    const loadSettings = vi.fn(async () => ({}) as never);
    const outcome = await runPrCommandPrologue(payload, "d1", spec(), deps({ hasSeenDelivery: async () => true, loadPullRequest, loadSettings }));
    expect(outcome.status).toBe("handled");
    expect(loadPullRequest).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("keys the redelivery guard on the command's OWN completed event and target key", async () => {
    const hasSeenDelivery = vi.fn(async () => false);
    await runPrCommandPrologue(payload, "delivery-9", spec({ completedEventType: "github_app.finding_resolved" }), deps({ hasSeenDelivery }));
    expect(hasSeenDelivery).toHaveBeenCalledWith("maintainer", "github_app.finding_resolved", "o/r#7", "delivery-9");
  });

  it("stops with `cached_pr_missing` when the PR is not in the cache", async () => {
    const recordSkip = vi.fn(async () => undefined);
    const outcome = await runPrCommandPrologue(payload, "d1", spec({ recordSkip }), deps({ loadPullRequest: async () => null }));
    expect(outcome.status).toBe("handled");
    expect(recordSkip).toHaveBeenCalledWith("cached_pr_missing", { repoFullName: "o/r", targetKey: "o/r#7", actor: "maintainer" });
  });

  it("records the denial WITH the authorization reason and actorKind, then stops", async () => {
    const recordDenied = vi.fn(async () => undefined);
    const outcome = await runPrCommandPrologue(payload, "d1", spec({ recordDenied }), deps({
      authorize: async () => ({ authorization: { authorized: false, reason: "not_a_maintainer", actorKind: "author" } }),
    }));
    expect(outcome.status).toBe("handled");
    expect(recordDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: "not_a_maintainer", actorKind: "author", targetKey: "o/r#7", actor: "maintainer" }));
  });

  it("INVARIANT: needsMinerDetection is threaded through verbatim — flipping it silently denies confirmed miners", async () => {
    // `pause`/`resolve`/`review` are deliberately widened to confirmed_miner. With the lookup off, no other
    // role could match them, so they are denied with no visible cause.
    const authorize = vi.fn(async () => ({ authorization: { authorized: true, reason: "", actorKind: "maintainer" } }));
    await runPrCommandPrologue(payload, "d1", spec({ needsMinerDetection: true }), deps({ authorize }));
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ needsMinerDetection: true }));
    await runPrCommandPrologue(payload, "d1", spec({ needsMinerDetection: false }), deps({ authorize }));
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ needsMinerDetection: false }));
  });

  it("hands the authorized handler everything it needs, so nothing is re-fetched or re-parsed", async () => {
    const outcome = await runPrCommandPrologue(payload, "d1", spec(), deps());
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.targetKey).toBe("o/r#7");
    expect(outcome.req).toBe(OK_REQUEST);
    expect(outcome.authorization.authorized).toBe(true);
    // The parsed command rides along so a handler can read its trailing argument (`@loopover resolve <id>`,
    // `@loopover pause <reason>`) without parsing the comment body a second time.
    expect(outcome.command.name).toBe("pause");
  });

  describe("requireOpenPr (#9020/#9311)", () => {
    it("stops a spending command on a closed PR", async () => {
      const recordSkip = vi.fn(async () => undefined);
      const outcome = await runPrCommandPrologue(payload, "d1", spec({ requireOpenPr: true, recordSkip }), deps({
        loadPullRequest: async () => ({ state: "closed" }) as never,
      }));
      expect(outcome.status).toBe("handled");
      expect(recordSkip).toHaveBeenCalledWith("pr_not_open", expect.objectContaining({ targetKey: "o/r#7" }));
    });

    it("INVARIANT: it is OPT-IN — read-only commands still work on a closed PR", async () => {
      // pause/resume/explain deliberately keep working after a PR closes; only the commands that spend real
      // money (AI generation, a branch commit) refuse.
      const outcome = await runPrCommandPrologue(payload, "d1", spec(), deps({ loadPullRequest: async () => ({ state: "closed" }) as never }));
      expect(outcome.status).toBe("ready");
    });

    it("INVARIANT: the open-PR check runs BEFORE authorization, so a closed PR costs no miner lookup", async () => {
      const authorize = vi.fn(async () => ({ authorization: { authorized: true, reason: "", actorKind: "maintainer" } }));
      await runPrCommandPrologue(payload, "d1", spec({ requireOpenPr: true }), deps({
        loadPullRequest: async () => ({ state: "closed" }) as never,
        authorize,
      }));
      expect(authorize).not.toHaveBeenCalled();
    });
  });
});
