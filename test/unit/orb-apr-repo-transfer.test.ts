import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallationToken } from "../../src/github/app";
import { getRepositorySettings } from "../../src/db/repositories";
import {
  APR_REPO_TRANSFER_EXPIRY_MS,
  classifyAprRepoTransferOutcome,
  evaluateAprRepoTransferRequestEligibility,
  initiateAprRepoTransfer,
  isAprRepoTransferPollEnabled,
  loadAprIdeaCompletion,
  loadPendingAprRepoTransfers,
  pollPendingAprRepoTransfers,
  probeAprRepoTransfer,
  recordAprRepoTransferOutcome,
  requestAprRepoTransfer,
  setAprRepoDispatchPaused,
  type AprRepoTransferPollDeps,
  type PendingAprRepoTransfer,
} from "../../src/orb/apr-repo-transfer";
import { createTestEnv } from "../helpers/d1";

// The transfer initiation mints an App installation token. Mock that mint to return a plain opaque token string
// — NEVER a PEM/private-key block. A prior attempt at this issue was auto-closed by the secret scanner for a
// key-shaped fixture in the diff; the token is opaque to this module, so a bare string is a faithful stand-in.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

/** Capture the outbound request so we can assert the endpoint, method, auth, and body. */
function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}

describe("initiateAprRepoTransfer (#7638)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue("ghs_installation_token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the transfer endpoint with new_owner and the installation token, returning the pending destination", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 });
    });

    const env = createTestEnv();
    const result = await initiateAprRepoTransfer(env, 4242, "loopover-repos/widgets", "customer-acct");

    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(seenUrl).toBe("https://api.github.com/repos/loopover-repos/widgets/transfer");
    expect(seenInit.method).toBe("POST");
    expect((seenInit.headers as Record<string, string>).authorization).toBe("Bearer ghs_installation_token");
    expect(JSON.parse(String(seenInit.body))).toEqual({ new_owner: "customer-acct" });
    expect(result).toEqual({ initiated: true, status: 202, newFullName: "customer-acct/widgets" });
  });

  it("models a successful response with no repo body as initiated with an unknown destination", async () => {
    stubFetch(() => new Response("", { status: 202 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: true, status: 202, newFullName: null });
  });

  it("treats a 2xx body that omits full_name as initiated with a null destination", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 99 }), { status: 202 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: true, status: 202, newFullName: null });
  });

  it("returns a structured error (never throws) when the target account does not exist (422)", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Could not resolve to a User with the login of 'ghost'." }), { status: 422 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "ghost");
    expect(result.initiated).toBe(false);
    expect(result).toMatchObject({ initiated: false, status: 422 });
    if (!result.initiated) expect(result.error).toContain("Could not resolve");
  });

  it("returns a structured error when the caller lacks admin access (403), with a fallback message on an empty body", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: false, status: 403, error: "transfer request failed (403)" });
  });

  it("falls back to a status message when response.text() rejects on a non-OK reply", async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error("body unread");
          },
        }) as unknown as Response,
    );
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: false, status: 500, error: "transfer request failed (500)" });
  });
});

describe("evaluateAprRepoTransferRequestEligibility (#7742)", () => {
  it("allows a request only when the idea-completion signal is true", () => {
    expect(evaluateAprRepoTransferRequestEligibility({ ideaComplete: true })).toEqual({ allowed: true });
  });

  it("rejects when the idea is not complete — including an explicit false", () => {
    expect(evaluateAprRepoTransferRequestEligibility({ ideaComplete: false })).toEqual({
      allowed: false,
      reason: "idea_not_complete",
    });
  });
});

describe("loadAprIdeaCompletion (#7742)", () => {
  it("fail-closes to incomplete until a persisted #7591/#7664 record exists", async () => {
    await expect(loadAprIdeaCompletion(createTestEnv(), { repoFullName: "loopover-repos/widgets" })).resolves.toEqual({
      ideaComplete: false,
    });
    await expect(
      loadAprIdeaCompletion(createTestEnv(), { repoFullName: "loopover-repos/widgets", ideaId: "idea-1" }),
    ).resolves.toEqual({ ideaComplete: false });
  });
});

describe("requestAprRepoTransfer (#7742)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects without calling initiate when the trusted lookup reports incomplete (default fail-closed)", async () => {
    const initiate = vi.fn();
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate },
    );
    expect(result).toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(initiate).not.toHaveBeenCalled();
  });

  it("rejects when an injectable lookup reports incomplete, without calling initiate", async () => {
    const initiate = vi.fn();
    const loadCompletion = vi.fn().mockResolvedValue({ ideaComplete: false });
    const env = createTestEnv();
    const result = await requestAprRepoTransfer(
      env,
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct", ideaId: "idea-9" },
      { initiate, loadCompletion },
    );
    expect(loadCompletion).toHaveBeenCalledWith(env, { repoFullName: "loopover-repos/widgets", ideaId: "idea-9" });
    expect(result).toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(initiate).not.toHaveBeenCalled();
  });

  it("initiates when a trusted lookup reports complete and the GitHub call succeeds", async () => {
    const initiate = vi.fn().mockResolvedValue({ initiated: true, status: 202, newFullName: "customer-acct/widgets" });
    const loadCompletion = vi.fn().mockResolvedValue({ ideaComplete: true });
    const env = createTestEnv();
    const result = await requestAprRepoTransfer(
      env,
      { installationId: 7, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate, loadCompletion },
    );
    expect(initiate).toHaveBeenCalledWith(env, 7, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });

  it("surfaces a structured failure when initiate returns initiated:false after a trusted complete lookup", async () => {
    const initiate = vi.fn().mockResolvedValue({ initiated: false, status: 403, error: "no admin" });
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate, loadCompletion: async () => ({ ideaComplete: true }) },
    );
    expect(result).toEqual({
      status: "failed",
      transfer: { initiated: false, status: 403, error: "no admin" },
    });
  });

  it("defaults to initiateAprRepoTransfer when no initiate hook is supplied and completion is trusted-complete", async () => {
    mockedToken.mockResolvedValue("ghs_installation_token");
    stubFetch(() => new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 }));
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { loadCompletion: async () => ({ ideaComplete: true }) },
    );
    expect(result).toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });

  it("pauses AMS dispatch for the source repo once a transfer is initiated (#7741 deliverable 2)", async () => {
    const initiate = vi.fn().mockResolvedValue({ initiated: true, status: 202, newFullName: "customer-acct/widgets" });
    const pauseDispatch = vi.fn().mockResolvedValue(undefined);
    const env = createTestEnv();
    const result = await requestAprRepoTransfer(
      env,
      { installationId: 3, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate, loadCompletion: async () => ({ ideaComplete: true }), pauseDispatch },
    );
    expect(result.status).toBe("initiated");
    expect(pauseDispatch).toHaveBeenCalledWith(env, "loopover-repos/widgets");
  });

  it("does NOT pause dispatch when the request is rejected or the initiation fails", async () => {
    const pauseDispatch = vi.fn().mockResolvedValue(undefined);
    const rejected = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate: vi.fn(), loadCompletion: async () => ({ ideaComplete: false }), pauseDispatch },
    );
    expect(rejected.status).toBe("rejected");
    const failed = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      {
        initiate: vi.fn().mockResolvedValue({ initiated: false, status: 403, error: "no admin" }),
        loadCompletion: async () => ({ ideaComplete: true }),
        pauseDispatch,
      },
    );
    expect(failed.status).toBe("failed");
    expect(pauseDispatch).not.toHaveBeenCalled();
  });
});

describe("isAprRepoTransferPollEnabled (#7741)", () => {
  it("is OFF unless the flag is explicitly truthy", () => {
    expect(isAprRepoTransferPollEnabled({})).toBe(false);
    expect(isAprRepoTransferPollEnabled({ LOOPOVER_APR_TRANSFER_POLL: "" })).toBe(false);
    expect(isAprRepoTransferPollEnabled({ LOOPOVER_APR_TRANSFER_POLL: "off" })).toBe(false);
    expect(isAprRepoTransferPollEnabled({ LOOPOVER_APR_TRANSFER_POLL: "1" })).toBe(true);
    expect(isAprRepoTransferPollEnabled({ LOOPOVER_APR_TRANSFER_POLL: " TRUE " })).toBe(true);
  });
});

describe("classifyAprRepoTransferOutcome (#7741)", () => {
  const initiatedAt = 1_000_000;

  it("is accepted the moment the repo resolves under the target owner", () => {
    expect(
      classifyAprRepoTransferOutcome({ probe: { state: "resolved_under_target" }, initiatedAt, now: initiatedAt }),
    ).toBe("accepted");
  });

  it("is accepted-and-departed when the App's access has moved away", () => {
    expect(
      classifyAprRepoTransferOutcome({ probe: { state: "access_departed" }, initiatedAt, now: initiatedAt + 1 }),
    ).toBe("accepted_departed");
  });

  it("stays pending inside the window and expires once the default 7-day window elapses", () => {
    const withinWindow = classifyAprRepoTransferOutcome({
      probe: { state: "pending" },
      initiatedAt,
      now: initiatedAt + APR_REPO_TRANSFER_EXPIRY_MS - 1,
    });
    expect(withinWindow).toBe("pending");
    const atWindow = classifyAprRepoTransferOutcome({
      probe: { state: "pending" },
      initiatedAt,
      now: initiatedAt + APR_REPO_TRANSFER_EXPIRY_MS,
    });
    expect(atWindow).toBe("expired");
  });

  it("honors a custom expiry override", () => {
    expect(
      classifyAprRepoTransferOutcome({ probe: { state: "pending" }, initiatedAt, now: initiatedAt + 500, expiryMs: 1000 }),
    ).toBe("pending");
    expect(
      classifyAprRepoTransferOutcome({ probe: { state: "pending" }, initiatedAt, now: initiatedAt + 1000, expiryMs: 1000 }),
    ).toBe("expired");
  });
});

describe("probeAprRepoTransfer (#7741)", () => {
  const mockedProbeToken = vi.mocked(createInstallationToken);
  const transfer = { repoFullName: "loopover-repos/widgets", newOwner: "customer-acct", installationId: 88 };
  beforeEach(() => {
    mockedProbeToken.mockReset();
    mockedProbeToken.mockResolvedValue("ghs_installation_token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the repo at its original path with the installation token", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ owner: { login: "customer-acct" } }), { status: 200 });
    });
    const probe = await probeAprRepoTransfer(createTestEnv(), transfer);
    expect(seenUrl).toBe("https://api.github.com/repos/loopover-repos/widgets");
    expect((seenInit.headers as Record<string, string>).authorization).toBe("Bearer ghs_installation_token");
    expect(probe).toEqual({ state: "resolved_under_target" });
  });

  it("treats a 404 (App access gone) as accepted-and-departed", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    expect(await probeAprRepoTransfer(createTestEnv(), transfer)).toEqual({ state: "access_departed" });
  });

  it("stays pending while the repo is still under the original owner", async () => {
    stubFetch(() => new Response(JSON.stringify({ owner: { login: "loopover-repos" } }), { status: 200 }));
    expect(await probeAprRepoTransfer(createTestEnv(), transfer)).toEqual({ state: "pending" });
  });

  it("stays pending on a 2xx body with no owner", async () => {
    stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    expect(await probeAprRepoTransfer(createTestEnv(), transfer)).toEqual({ state: "pending" });
  });

  it("stays pending when the body is not valid JSON", async () => {
    stubFetch(() => new Response("<<not json>>", { status: 200 }));
    expect(await probeAprRepoTransfer(createTestEnv(), transfer)).toEqual({ state: "pending" });
  });

  it("stays pending on a transient non-404 error so the next poll retries", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    expect(await probeAprRepoTransfer(createTestEnv(), transfer)).toEqual({ state: "pending" });
  });
});

describe("setAprRepoDispatchPaused (#7741 deliverable 2)", () => {
  it("toggles the existing per-repo agentPaused kill-switch", async () => {
    const env = createTestEnv();
    await setAprRepoDispatchPaused(env, "loopover-repos/widgets", true);
    expect((await getRepositorySettings(env, "loopover-repos/widgets")).agentPaused).toBe(true);
    await setAprRepoDispatchPaused(env, "loopover-repos/widgets", false);
    expect((await getRepositorySettings(env, "loopover-repos/widgets")).agentPaused).toBe(false);
  });
});

describe("loadPendingAprRepoTransfers / recordAprRepoTransferOutcome (#7741, fail-empty until #7664)", () => {
  it("loads no pending transfers until a persisted record store lands", async () => {
    await expect(loadPendingAprRepoTransfers(createTestEnv())).resolves.toEqual([]);
  });

  it("records a terminal outcome as a no-op today", async () => {
    await expect(
      recordAprRepoTransferOutcome(
        createTestEnv(),
        { repoFullName: "loopover-repos/widgets", newOwner: "customer-acct", installationId: 1, initiatedAt: 0 },
        "accepted",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("pollPendingAprRepoTransfers (#7741 deliverables 1+2)", () => {
  const now = 10_000_000;
  const base = { newOwner: "customer-acct", installationId: 5 };

  /** Build injectable deps whose probe answers per-repo, recording every pause/resume and terminal write. */
  function makeDeps(
    pending: PendingAprRepoTransfer[],
    probeByRepo: Record<string, { state: "resolved_under_target" | "access_departed" | "pending" }>,
    overrides: Partial<AprRepoTransferPollDeps> = {},
  ) {
    const paused: Array<{ repoFullName: string; paused: boolean }> = [];
    const resolved: Array<{ repoFullName: string; outcome: string }> = [];
    const deps: AprRepoTransferPollDeps = {
      listPending: async () => pending,
      probe: async (_env, t) => probeByRepo[t.repoFullName]!,
      now: () => now,
      markResolved: async (_env, t, outcome) => {
        resolved.push({ repoFullName: t.repoFullName, outcome });
      },
      setDispatchPaused: async (_env, repoFullName, p) => {
        paused.push({ repoFullName, paused: p });
      },
      ...overrides,
    };
    return { deps, paused, resolved };
  }

  it("reconciles accepted, accepted-departed, and still-pending transfers in one pass", async () => {
    const pending: PendingAprRepoTransfer[] = [
      { ...base, repoFullName: "loopover-repos/accepted", initiatedAt: now - 1000 },
      { ...base, repoFullName: "loopover-repos/departed", initiatedAt: now - 1000 },
      { ...base, repoFullName: "loopover-repos/waiting", initiatedAt: now - 1000 },
    ];
    const { deps, paused, resolved } = makeDeps(
      pending,
      {
        "loopover-repos/accepted": { state: "resolved_under_target" },
        "loopover-repos/departed": { state: "access_departed" },
        "loopover-repos/waiting": { state: "pending" },
      },
      { expiryMs: 5000 },
    );

    const results = await pollPendingAprRepoTransfers(createTestEnv(), deps);

    expect(results).toEqual([
      { repoFullName: "loopover-repos/accepted", outcome: "accepted" },
      { repoFullName: "loopover-repos/departed", outcome: "accepted_departed" },
      { repoFullName: "loopover-repos/waiting", outcome: "pending" },
    ]);
    // accepted → resume (still installed); departed → no pause toggle; pending → re-assert the freeze.
    expect(paused).toEqual([
      { repoFullName: "loopover-repos/accepted", paused: false },
      { repoFullName: "loopover-repos/waiting", paused: true },
    ]);
    expect(resolved).toEqual([
      { repoFullName: "loopover-repos/accepted", outcome: "accepted" },
      { repoFullName: "loopover-repos/departed", outcome: "accepted_departed" },
    ]);
  });

  it("expires a transfer that never resolves within the default 7-day window and resumes dispatch", async () => {
    const pending: PendingAprRepoTransfer[] = [
      { ...base, repoFullName: "loopover-repos/stale", initiatedAt: now - APR_REPO_TRANSFER_EXPIRY_MS },
    ];
    const { deps, paused, resolved } = makeDeps(pending, {
      "loopover-repos/stale": { state: "pending" },
    });

    const results = await pollPendingAprRepoTransfers(createTestEnv(), deps);

    expect(results).toEqual([{ repoFullName: "loopover-repos/stale", outcome: "expired" }]);
    expect(resolved).toEqual([{ repoFullName: "loopover-repos/stale", outcome: "expired" }]);
    expect(paused).toEqual([{ repoFullName: "loopover-repos/stale", paused: false }]);
  });
});
