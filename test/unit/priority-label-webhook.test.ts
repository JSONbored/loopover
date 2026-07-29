// The `issues.labeled` enforcement path for #9737, end to end through the real webhook processor.
//
// The DECISION has its own unit tests (priority-label-eligibility.test.ts); this covers the I/O the
// decision drives: the permission read, the label removal, the marked comment, and the ledger event -- plus
// the paths that must do NOTHING, which is where a rule like this does damage if it is wrong.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";
import { upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as repositorySettingsModule from "../../src/settings/repository-settings";
import { PRIORITY_LABEL_COMMENT_MARKER, PRIORITY_LABEL_ENFORCEMENT_EVENT } from "../../src/review/priority-label-eligibility";

const REPO = "JSONbored/gittensory";

/** Same helper the other webhook suites use: the App path needs a real key to mint an installation token. */
function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

type Call = { method: string; url: string; body?: string };

/** Stub GitHub: records every call, answers the three endpoints this path touches. */
function stubGitHub(permission: string | null, calls: Call[], existingComments: Array<{ id: number; body: string; user?: { login: string; type?: string } }> = []) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });

    if (url.includes("/access_tokens")) return Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
    if (url.includes("/collaborators/") && url.endsWith("/permission")) {
      return permission === null ? new Response("nope", { status: 404 }) : Response.json({ permission });
    }
    if (url.includes("/issues/") && url.includes("/comments") && method === "GET") return Response.json(existingComments);
    if (url.includes("/issues/") && url.includes("/comments") && method === "POST") return Response.json({ id: 1, html_url: "u" });
    if (url.includes("/comments/") && method === "PATCH") return Response.json({ id: 1, html_url: "u" });
    if (url.includes("/labels/") && method === "DELETE") return Response.json([]);
    if (url.includes("/installation")) return Response.json({ id: 123, account: { login: "JSONbored" } });
    return new Response("not found", { status: 404 });
  });
}

async function seed() {
  const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), GITHUB_APP_SLUG: "loopover-orb" });
  await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } } as never);
  await upsertRepositorySettings(env, { repoFullName: REPO, typeLabelsEnabled: true });
  return env;
}

function labeledPayload(over: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    installation: { id: 123 },
    repository: { full_name: REPO, name: "gittensory", private: false, owner: { login: "JSONbored" } },
    sender: { login: "someone" },
    label: { name: "gittensor:priority" },
    issue: {
      number: 7,
      title: "An issue",
      state: "open",
      user: { login: "contributor" },
      labels: [{ name: "gittensor:priority" }],
      ...over,
    },
  };
}

async function run(env: ReturnType<typeof createTestEnv>, payload: unknown, deliveryId = "d1") {
  await processJob(env, { type: "github-webhook", deliveryId, eventName: "issues", payload } as never);
}

describe("issues.labeled priority enforcement (#9737)", () => {
  afterEach(() => {
    // The stubbed fetch and any resolver spy must not leak into the next case -- a leaked spy here would
    // silently make a later assertion pass for the wrong reason.
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("strips the label, comments once with the marker, and records the enforcement", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload());

    const removed = calls.find((call) => call.method === "DELETE" && call.url.includes("/labels/"));
    expect(removed, "the label is removed").toBeTruthy();
    expect(decodeURIComponent(removed!.url)).toContain("gittensor:priority");

    const commented = calls.find((call) => call.method === "POST" && call.url.includes("/comments"));
    expect(commented?.body, "the comment carries the marker so a re-label updates it").toContain(PRIORITY_LABEL_COMMENT_MARKER);

    const audit = await env.DB.prepare("select detail, outcome from audit_events where event_type = ?")
      .bind(PRIORITY_LABEL_ENFORCEMENT_EVENT)
      .first<{ detail: string; outcome: string }>();
    expect(audit?.outcome).toBe("success");
    expect(audit?.detail, "the ledger says which rule fired and why").toContain("priority-label-author-eligibility");
  });

  it("UPDATES the existing comment on a re-label instead of posting a second one", async () => {
    const env = await seed();
    const calls: Call[] = [];
    // The bot's own prior notice is already on the thread.
    // Authored by the App itself -- the upsert only ever updates its OWN marked comment, never a human's.
    stubGitHub("read", calls, [{ id: 55, body: `${PRIORITY_LABEL_COMMENT_MARKER}\n\nolder text`, user: { login: "loopover-orb[bot]", type: "Bot" } }]);

    await run(env, labeledPayload(), "d-relabel");

    expect(calls.some((call) => call.method === "POST" && call.url.includes("/comments")), "no second comment").toBe(false);
  });

  it("does NOTHING for a maintainer-authored issue", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("admin", calls);

    await run(env, labeledPayload(), "d-maintainer");

    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/comments"))).toBe(false);
  });

  it("FAILS OPEN when the permission cannot be read", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub(null, calls);

    await run(env, labeledPayload(), "d-unreadable");

    expect(calls.some((call) => call.method === "DELETE"), "an unreadable permission never strips a label").toBe(false);
  });

  it("ignores a PULL REQUEST carrying the same label", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ pull_request: { url: "https://api.github.com/pulls/7" } }), "d-pr");

    // The same label name is the PR TYPE label ORB applies itself; touching it would fight the labeller.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(calls.some((call) => call.url.includes("/permission")), "and costs no permission read").toBe(false);
  });

  it("ignores a labeled event for a DIFFERENT label", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ labels: [{ name: "gittensor:bug" }] }), "d-other-label");

    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("ignores an issues action that is not `labeled`", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, { ...labeledPayload(), action: "opened" }, "d-opened");

    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("ignores an `issues` payload missing the fields it needs, rather than throwing on the webhook path", async () => {
    // A webhook handler that throws on a shape it did not expect fails the whole delivery, including every
    // handler after it. Each of these is a field this path reads.
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    const base = labeledPayload();
    for (const [name, payload] of [
      ["no repository", { ...base, repository: undefined }],
      ["no issue", { ...base, issue: undefined }],
      ["no installation", { ...base, installation: undefined }],
    ] as const) {
      await expect(run(env, payload, `d-missing-${name.replace(/\s/g, "-")}`), name).resolves.not.toThrow();
    }
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("handles an issue with no author and no labels without reading a permission", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ user: undefined, labels: undefined }), "d-bare-issue");

    expect(calls.some((call) => call.url.includes("/permission"))).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("records the enforcement even when the webhook carries no sender", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    const { sender: _sender, ...senderless } = labeledPayload();
    await run(env, senderless, "d-no-sender");

    const audit = await env.DB.prepare("select actor from audit_events where event_type = ?")
      .bind(PRIORITY_LABEL_ENFORCEMENT_EVENT)
      .first<{ actor: string | null }>();
    expect(audit, "the strip is still recorded").toBeTruthy();
    expect(audit?.actor, "with no actor rather than a fabricated one").toBeNull();
  });

  it("honours a repo's CUSTOM priority label name", async () => {
    // The label is per-repo configurable; enforcing the default name on a repo that renamed it would both
    // miss the real label and touch one the repo does not use for this.
    const env = await seed();
    // typeLabels is config-as-code only (no DB column). The RESOLVER is stubbed rather than a manifest
    // fixture written: what this asserts is that the handler reads the resolved label instead of the
    // built-in default -- how a repo comes to have a custom one is resolveEffectiveSettings' own business,
    // and it has its own tests.
    const resolved = await repositorySettingsModule.resolveRepositorySettings(env, REPO);
    vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockResolvedValue({
      ...resolved,
      typeLabels: { ...resolved.typeLabels, priority: "team:top" },
    });
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ labels: [{ name: "team:top" }] }), "d-custom-label");

    const removed = calls.find((call) => call.method === "DELETE" && call.url.includes("/labels/"));
    expect(decodeURIComponent(removed?.url ?? "")).toContain("team:top");
  });

  it("tolerates a label entry with no name", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ labels: [{}, { name: "gittensor:priority" }] }), "d-nameless-label");

    expect(calls.some((call) => call.method === "DELETE"), "the real label is still found and removed").toBe(true);
  });

  // Every I/O call on this path is wrapped in a `.catch` that degrades rather than failing the delivery.
  // Those handlers are the whole reason a label-mutating rule is safe to run on a webhook -- an escaping
  // throw would fail the delivery and take every handler after it on the same event down with it. They are
  // tested by making the call actually THROW: a 404 response exercises the ordinary return, not the catch.
  it("falls back to the DEFAULT label name when the settings resolver throws", async () => {
    const env = await seed();
    vi.spyOn(repositorySettingsModule, "resolveRepositorySettings").mockRejectedValue(new Error("D1 unavailable"));
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload(), "d-settings-throw");

    const removed = calls.find((call) => call.method === "DELETE" && call.url.includes("/labels/"));
    expect(decodeURIComponent(removed?.url ?? ""), "an unreadable config still enforces the built-in label").toContain("gittensor:priority");
  });

  it("FAILS OPEN when the permission read throws rather than answering", async () => {
    const env = await seed();
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), url });
      if (url.includes("/access_tokens")) return Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
      if (url.includes("/permission")) throw new Error("socket hang up");
      return new Response("not found", { status: 404 });
    });

    await run(env, labeledPayload(), "d-permission-throws");

    expect(calls.some((call) => call.method === "DELETE"), "a thrown permission read is not evidence of ineligibility").toBe(false);
  });

  it("still records the enforcement when the label removal and the comment both throw", async () => {
    // A GitHub outage mid-enforcement must not fail the whole delivery.
    const env = await seed();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/access_tokens")) return Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
      if (url.includes("/collaborators/") && url.endsWith("/permission")) return Response.json({ permission: "read" });
      if (method === "DELETE" || url.includes("/comments")) throw new Error("GitHub 502");
      if (url.includes("/installation")) return Response.json({ id: 123, account: { login: "JSONbored" } });
      return new Response("not found", { status: 404 });
    });

    await expect(run(env, labeledPayload(), "d-mutations-throw")).resolves.not.toThrow();

    const audit = await env.DB.prepare("select outcome from audit_events where event_type = ?")
      .bind(PRIORITY_LABEL_ENFORCEMENT_EVENT)
      .first<{ outcome: string }>();
    expect(audit?.outcome, "the decision is still on the record even when the mutation failed").toBe("success");
  });

  it("does not fail the delivery when the ledger writes themselves throw", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);
    // The last two `.catch`es: the audit row and the webhook-event row. Both are recording, not acting --
    // losing them must not undo an enforcement that already happened on GitHub.
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      // Drizzle quotes its table names, the raw-SQL writers do not -- match both.
      if (/insert\s+(or\s+\w+\s+)?into\s+"?(audit_events|webhook_events)"?/i.test(sql)) throw new Error("D1 write failed");
      return realPrepare(sql);
    });

    await expect(run(env, labeledPayload(), "d-ledger-throw")).resolves.not.toThrow();

    expect(calls.some((call) => call.method === "DELETE"), "the label was still removed").toBe(true);
  });

  it("tolerates an author object with no login", async () => {
    const env = await seed();
    const calls: Call[] = [];
    stubGitHub("read", calls);

    await run(env, labeledPayload({ user: {} }), "d-nameless-author");

    expect(calls.some((call) => call.url.includes("/permission")), "no author means no permission read").toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});
