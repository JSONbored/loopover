import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchChatAction, registerChatAction } = vi.hoisted(() => ({
  dispatchChatAction: vi.fn(),
  registerChatAction: vi.fn(),
}));

vi.mock("../../../../packages/loopover-miner/lib/chat-action-dispatch.js", () => ({
  CHAT_ACTION_DISPATCH_FLAG: "LOOPOVER_MINER_CHAT_ACTIONS",
  CHAT_ACTION_DISPATCH_ENABLE_VALUE: "enabled",
  dispatchChatAction,
}));

vi.mock("../../../../packages/loopover-miner/lib/chat-action-registry.js", () => {
  const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");
  return {
    createChatActionRegistry: () => {
      throw new Error("tests use an injected isolated registry");
    },
    registerChatAction,
    governorGatedHandler: (run: (request: unknown) => unknown) => {
      const handler = async (request: unknown) => {
        const result = await run(request);
        return { ok: true, status: "executed", decision: { stage: "allow" }, result };
      };
      Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
      return handler;
    },
    isGovernorGatedHandler: (handler: unknown) =>
      typeof handler === "function" && (handler as unknown as { [k: symbol]: unknown })[GOVERNOR_GATED] === true,
  };
});

import { MessageList } from "../components/chat/message-list";
import { portfolioQueueActionConversation } from "../components/chat/fixtures";
import {
  formatPortfolioQueueChatResultMessage,
  handlePortfolioQueueChatCommand,
  matchPortfolioQueueChatTarget,
  PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
  PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
  registerPortfolioQueueChatActions,
  resetPortfolioQueueChatActionsRegistrationForTest,
  resolvePortfolioQueueChatAction,
} from "./chat-portfolio-queue-actions";
import {
  PORTFOLIO_QUEUE_RELEASE_API_PATH,
  PORTFOLIO_QUEUE_REQUEUE_API_PATH,
  type PortfolioQueueActionItem,
} from "./portfolio-queue-actions";

const inProgressItem: PortfolioQueueActionItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue:12",
  status: "in_progress",
};

const doneItem: PortfolioQueueActionItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue:7",
  status: "done",
};

const allowGate = () => ({ decision: { stage: "allow" } });
const enabledEnv = { LOOPOVER_MINER_CHAT_ACTIONS: "enabled" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function isolatedRegistry() {
  const actions = new Map<
    string,
    { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> }
  >();
  return {
    register(
      name: string,
      definition: { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> },
    ) {
      actions.set(name, definition);
      return definition;
    },
    get: (name: string) => actions.get(name),
    has: (name: string) => actions.has(name),
    names: () => [...actions.keys()],
    get size() {
      return actions.size;
    },
  };
}

describe("resolvePortfolioQueueChatAction (#6520)", () => {
  it("resolves release/requeue with a repo and optional identifier", () => {
    expect(resolvePortfolioQueueChatAction("release acme/widgets")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      target: { repoFullName: "acme/widgets" },
    });
    expect(resolvePortfolioQueueChatAction("please requeue org/repo #7")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
      target: { repoFullName: "org/repo", identifier: "issue:7" },
    });
    expect(resolvePortfolioQueueChatAction("release the queued item for acme/widgets issue:12")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      target: { repoFullName: "acme/widgets", identifier: "issue:12" },
    });
  });

  it("rejects empty, action-less, dual-action, and repo-less text without guessing", () => {
    for (const text of [
      "",
      "   ",
      "status please",
      "release something",
      "release and requeue acme/widgets",
      "requeued acme/widgets",
    ]) {
      const result = resolvePortfolioQueueChatAction(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Couldn't determine/i);
    }
  });
});

describe("matchPortfolioQueueChatTarget (#6520)", () => {
  it("matches release to in_progress and requeue to done", () => {
    const items = { ok: true as const, items: [inProgressItem, doneItem] };
    expect(
      matchPortfolioQueueChatTarget(PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION, { repoFullName: "acme/widgets" }, items),
    ).toEqual({
      ok: true,
      item: inProgressItem,
    });
    expect(
      matchPortfolioQueueChatTarget(
        PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
        { repoFullName: "acme/widgets", identifier: "issue:7" },
        items,
      ),
    ).toEqual({
      ok: true,
      item: doneItem,
    });
  });

  it("rejects items-API errors, zero matches, and ambiguous multi-matches", () => {
    expect(
      matchPortfolioQueueChatTarget(
        PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
        { repoFullName: "acme/widgets" },
        { ok: false, error: "down" },
      ).ok,
    ).toBe(false);
    expect(
      matchPortfolioQueueChatTarget(
        PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
        { repoFullName: "acme/widgets" },
        { ok: true, items: [doneItem] },
      ).ok,
    ).toBe(false);
    const twin: PortfolioQueueActionItem = { ...inProgressItem, identifier: "issue:99" };
    const ambiguous = matchPortfolioQueueChatTarget(
      PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      { repoFullName: "acme/widgets" },
      { ok: true, items: [inProgressItem, twin] },
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.message).toMatch(/name an identifier/i);
  });
});

describe("handlePortfolioQueueChatCommand (#6520)", () => {
  beforeEach(() => {
    resetPortfolioQueueChatActionsRegistrationForTest();
    dispatchChatAction.mockReset();
    registerChatAction.mockReset();
  });

  it("rejects an unresolvable instruction before the dispatch layer is invoked", async () => {
    const result = await handlePortfolioQueueChatCommand("what is the queue status?", {
      registry: isolatedRegistry() as never,
      loadItems: async () => {
        throw new Error("must not load items");
      },
      buildGovernorInput: () => {
        throw new Error("must not build governor input");
      },
      evaluateGate: allowGate,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-1",
    });

    expect(result.dispatched).toBe(false);
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringMatching(/Couldn't determine/i),
      }),
    ]);
    expect(dispatchChatAction).not.toHaveBeenCalled();
  });

  it("dispatches a successful release through the shared layer and surfaces it in the message list", async () => {
    const registry = isolatedRegistry();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(PORTFOLIO_QUEUE_RELEASE_API_PATH);
      return jsonResponse({ entry: { repoFullName: "acme/widgets", identifier: "issue:12", status: "queued" } });
    });

    dispatchChatAction.mockImplementation(async (request: { action?: string; params?: unknown }) => {
      const entry = registry.get(request.action ?? "");
      expect(entry).toBeTruthy();
      expect(entry!.paramsValidator(request.params)).toBe(true);
      const handlerResult = await entry!.handler(request);
      return { ok: true, status: "dispatched", action: request.action, result: handlerResult };
    });

    const result = await handlePortfolioQueueChatCommand("release acme/widgets #12", {
      env: enabledEnv,
      registry: registry as never,
      loadItems: async () => ({ ok: true, items: [inProgressItem, doneItem] }),
      buildGovernorInput: () => ({ actionClass: "open_pr" }),
      evaluateGate: allowGate,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-release",
    });

    expect(result.dispatched).toBe(true);
    expect(dispatchChatAction).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.messages[0]?.content).toContain("Queue release succeeded for acme/widgets (issue:12)");
    expect(result.messages[0]?.role).toBe("system");
  });

  it("dispatches a successful requeue through the shared layer", async () => {
    const registry = isolatedRegistry();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(PORTFOLIO_QUEUE_REQUEUE_API_PATH);
      return jsonResponse({ entry: { repoFullName: "acme/widgets", identifier: "issue:7", status: "queued" } });
    });

    dispatchChatAction.mockImplementation(async (request: { action?: string; params?: unknown }) => {
      const entry = registry.get(request.action ?? "");
      const handlerResult = await entry!.handler(request);
      return { ok: true, status: "dispatched", action: request.action, result: handlerResult };
    });

    const result = await handlePortfolioQueueChatCommand("requeue acme/widgets", {
      env: enabledEnv,
      registry: registry as never,
      loadItems: async () => ({ ok: true, items: [doneItem] }),
      buildGovernorInput: () => ({}),
      evaluateGate: allowGate,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-requeue",
    });

    expect(result.dispatched).toBe(true);
    expect(result.messages[0]?.content).toContain("Queue requeue succeeded for acme/widgets (issue:7)");
  });

  it("surfaces an endpoint error verbatim in the message list", async () => {
    const registry = isolatedRegistry();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "item is not in_progress" }, 409));

    dispatchChatAction.mockImplementation(async (request: { action?: string; params?: unknown }) => {
      const entry = registry.get(request.action ?? "");
      const handlerResult = await entry!.handler(request);
      return { ok: true, status: "dispatched", action: request.action, result: handlerResult };
    });

    const result = await handlePortfolioQueueChatCommand("release acme/widgets", {
      env: enabledEnv,
      registry: registry as never,
      loadItems: async () => ({ ok: true, items: [inProgressItem] }),
      buildGovernorInput: () => ({}),
      evaluateGate: allowGate,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-err",
    });

    expect(result.dispatched).toBe(true);
    expect(result.messages[0]?.content).toContain("item is not in_progress");
  });

  it("reports disabled when the scaffolding flag is off (still after a successful resolve+match)", async () => {
    const registry = isolatedRegistry();
    registerPortfolioQueueChatActions({ registry: registry as never, evaluateGate: allowGate });
    dispatchChatAction.mockResolvedValue({
      ok: false,
      status: "disabled",
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
    });

    const result = await handlePortfolioQueueChatCommand("release acme/widgets", {
      env: {},
      registry: registry as never,
      loadItems: async () => ({ ok: true, items: [inProgressItem] }),
      buildGovernorInput: () => ({}),
      evaluateGate: allowGate,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-disabled",
    });

    expect(result.dispatched).toBe(true);
    expect(result.messages[0]?.content).toMatch(/Chat actions are disabled/i);
  });
});

describe("formatPortfolioQueueChatResultMessage + MessageList (#6520)", () => {
  it("renders portfolio action-result fixtures inline in the message list", () => {
    render(<MessageList messages={portfolioQueueActionConversation} />);
    expect(screen.getByText(/Queue release succeeded for acme\/widgets/i)).toBeTruthy();
    expect(screen.getByText(/Queue requeue succeeded for acme\/widgets/i)).toBeTruthy();
  });

  it("formats a gated dispatch as a system message naming the target", () => {
    const message = formatPortfolioQueueChatResultMessage({
      id: "g1",
      timestamp: "2026-07-16T09:00:00.000Z",
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      item: inProgressItem,
      dispatch: {
        ok: true,
        status: "dispatched",
        action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
        result: { ok: false, status: "gated", decision: { stage: "kill_switch" } },
      },
    });
    expect(message.content).toMatch(/Governor blocked the release for acme\/widgets \(issue:12\)/);
  });

  it("formats errorMessage, invalid_params, unknown_action, and fallback dispatch lines", () => {
    expect(
      formatPortfolioQueueChatResultMessage({
        id: "e1",
        timestamp: "2026-07-16T09:00:00.000Z",
        action: null,
        errorMessage: "Couldn't determine a portfolio-queue action.",
      }).content,
    ).toBe("Couldn't determine a portfolio-queue action.");

    expect(
      formatPortfolioQueueChatResultMessage({
        id: "e2",
        timestamp: "2026-07-16T09:00:00.000Z",
        action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
        dispatch: { ok: false, status: "invalid_params", action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION },
      }).content,
    ).toMatch(/invalid parameters/i);

    expect(
      formatPortfolioQueueChatResultMessage({
        id: "e3",
        timestamp: "2026-07-16T09:00:00.000Z",
        action: PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
        dispatch: { ok: false, status: "unknown_action", action: PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION },
      }).content,
    ).toMatch(/not registered/i);

    expect(
      formatPortfolioQueueChatResultMessage({
        id: "e4",
        timestamp: "2026-07-16T09:00:00.000Z",
        action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
        item: inProgressItem,
        dispatch: {
          ok: true,
          status: "dispatched",
          action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
          result: { ok: true, status: "executed" },
        },
      }).content,
    ).toMatch(/Queue release dispatched for acme\/widgets/);
  });

  it("rejects a chat target when the items loader fails to match", async () => {
    const result = await handlePortfolioQueueChatCommand("release missing/repo", {
      registry: isolatedRegistry() as never,
      loadItems: async () => ({ ok: true, items: [] }),
      buildGovernorInput: () => ({}),
      evaluateGate: allowGate,
      nowIso: () => "2026-07-16T09:00:00.000Z",
      newId: () => "sys-nomatch",
    });
    expect(result.dispatched).toBe(false);
    expect(result.messages[0]?.content).toMatch(/Couldn't determine a portfolio-queue target/i);
  });
});

// #8640: the live registration below is the ONLY portfolio release/requeue registration in the repo. The
// deleted packages/loopover-miner/lib/chat-portfolio-actions.ts was a fully-orphaned duplicate that registered
// the same handlers under the `portfolio_release` / `portfolio_requeue` UNDERSCORE names. This guard fails the
// instant that duplicate (or its underscore action names) is reintroduced anywhere the live registration runs.
describe("portfolio chat-action registration is single-sourced (#8640)", () => {
  it("registers only the dotted portfolio.release/requeue names, never the deleted duplicate's underscore variant", () => {
    const registry = isolatedRegistry();
    registerPortfolioQueueChatActions({ registry: registry as never, evaluateGate: allowGate });
    const names = registry.names();
    expect(names).toContain(PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION);
    expect(names).toContain(PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION);
    expect(names).not.toContain("portfolio_release");
    expect(names).not.toContain("portfolio_requeue");
  });
});
