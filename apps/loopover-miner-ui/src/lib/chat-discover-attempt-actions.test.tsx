import { describe, expect, it, vi } from "vitest";

// chat-action-registry → governor-chokepoint → governor-ledger → node:sqlite. jsdom/Vite cannot bundle that
// builtin (#6837); keep a client-safe registry twin so the real registration module loads. Same pattern as
// chat-governor-actions.test.tsx.
vi.mock("../../../../packages/loopover-miner/lib/chat-action-registry.js", () => {
  const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

  function isGovernorGatedHandler(handler: unknown): boolean {
    return typeof handler === "function" && (handler as unknown as { [k: symbol]: unknown })[GOVERNOR_GATED] === true;
  }

  function governorGatedHandler(
    run: (request: unknown, gate: unknown) => unknown,
    options: { evaluateGate?: (input?: unknown) => { decision: { stage: string } } } = {},
  ) {
    const evaluateGate = options.evaluateGate ?? (() => ({ decision: { stage: "allow" } }));
    const handler = async (request: { governorInput?: unknown }) => {
      const gate = evaluateGate(request?.governorInput);
      if (gate?.decision?.stage !== "allow") {
        return { ok: false, status: "gated", decision: gate?.decision ?? null };
      }
      const result = await run(request, gate);
      return { ok: true, status: "executed", decision: gate.decision, result };
    };
    Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
    return handler;
  }

  function createChatActionRegistry() {
    const actions = new Map<
      string,
      { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> }
    >();
    return {
      register(
        name: string,
        definition: {
          paramsValidator: (params: unknown) => boolean;
          handler: (request: unknown) => Promise<unknown>;
        },
      ) {
        if (!isGovernorGatedHandler(definition.handler)) {
          throw new Error(`registerChatAction("${name}"): handler must be produced by governorGatedHandler()`);
        }
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

  return {
    createChatActionRegistry,
    governorGatedHandler,
    isGovernorGatedHandler,
    chatActionRegistry: createChatActionRegistry(),
    registerChatAction: () => {
      throw new Error("tests use an injected isolated registry");
    },
  };
});

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
} from "../../../../packages/loopover-miner/lib/chat-action-dispatch.js";
import { createChatActionRegistry } from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  registerDiscoverAttemptChatActions,
} from "./chat-discover-attempt-actions";
import { requestAttempt } from "./attempt";
import { requestDiscover } from "./discover";

const enabledEnv = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };

const discoverOk = { ok: true as const, result: { enqueued: 2 }, exitCode: 0 };
const attemptOk = { ok: true as const, result: { outcome: "submitted" }, exitCode: 0 };

const validAttemptParams = { repoFullName: "acme/widgets", issueNumber: 12, minerLogin: "octocat" };

describe("registerDiscoverAttemptChatActions (#6837)", () => {
  it("registers discover and attempt into the supplied registry", () => {
    const registry = createChatActionRegistry();
    registerDiscoverAttemptChatActions({ registry });
    expect(registry.has(DISCOVER_CHAT_ACTION)).toBe(true);
    expect(registry.has(ATTEMPT_CHAT_ACTION)).toBe(true);
  });

  it("routes a dispatched discover only through requestDiscover, never attempt", async () => {
    const registry = createChatActionRegistry();
    const requestDiscoverFn = vi.fn(async () => discoverOk);
    const requestAttemptFn = vi.fn(async () => attemptOk);
    registerDiscoverAttemptChatActions({ registry, requestDiscoverFn, requestAttemptFn });

    const dispatch = await dispatchChatAction(
      { action: DISCOVER_CHAT_ACTION, params: { search: "typescript", dryRun: true } },
      { env: enabledEnv, registry },
    );

    expect(dispatch).toMatchObject({ ok: true, status: "dispatched" });
    expect(dispatch.result).toMatchObject({ status: "executed", result: discoverOk });
    expect(requestDiscoverFn).toHaveBeenCalledWith({ search: "typescript", dryRun: true });
    expect(requestAttemptFn).not.toHaveBeenCalled();
  });

  it("forwards nullish discover params to requestDiscover as an empty object", async () => {
    const registry = createChatActionRegistry();
    const requestDiscoverFn = vi.fn(async () => discoverOk);
    registerDiscoverAttemptChatActions({ registry, requestDiscoverFn, requestAttemptFn: vi.fn(async () => attemptOk) });

    await dispatchChatAction({ action: DISCOVER_CHAT_ACTION }, { env: enabledEnv, registry });

    expect(requestDiscoverFn).toHaveBeenCalledWith({});
  });

  it("routes a dispatched attempt only through requestAttempt, never discover", async () => {
    const registry = createChatActionRegistry();
    const requestDiscoverFn = vi.fn(async () => discoverOk);
    const requestAttemptFn = vi.fn(async () => attemptOk);
    registerDiscoverAttemptChatActions({ registry, requestDiscoverFn, requestAttemptFn });

    const dispatch = await dispatchChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: validAttemptParams },
      { env: enabledEnv, registry },
    );

    expect(dispatch).toMatchObject({ ok: true, status: "dispatched" });
    expect(dispatch.result).toMatchObject({ status: "executed", result: attemptOk });
    expect(requestAttemptFn).toHaveBeenCalledWith(validAttemptParams);
    expect(requestDiscoverFn).not.toHaveBeenCalled();
  });

  it("rejects an attempt with missing required params before reaching the client", async () => {
    const registry = createChatActionRegistry();
    const requestAttemptFn = vi.fn(async () => attemptOk);
    registerDiscoverAttemptChatActions({
      registry,
      requestDiscoverFn: vi.fn(async () => discoverOk),
      requestAttemptFn,
    });

    const dispatch = await dispatchChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: { repoFullName: "acme/widgets" } },
      { env: enabledEnv, registry },
    );

    expect(dispatch).toMatchObject({ ok: false, status: "invalid_params" });
    expect(requestAttemptFn).not.toHaveBeenCalled();
  });

  it("does not run the client when the injected gate denies the write", async () => {
    const registry = createChatActionRegistry();
    const requestAttemptFn = vi.fn(async () => attemptOk);
    registerDiscoverAttemptChatActions({
      registry,
      requestDiscoverFn: vi.fn(async () => discoverOk),
      requestAttemptFn,
      evaluateGate: () => ({ decision: { stage: "block" } }),
    });

    const dispatch = await dispatchChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: validAttemptParams },
      { env: enabledEnv, registry },
    );

    expect(dispatch).toMatchObject({ ok: true, status: "dispatched" });
    expect(dispatch.result).toMatchObject({ status: "gated" });
    expect(requestAttemptFn).not.toHaveBeenCalled();
  });

  it("regression: default wiring binds the exported requestDiscover/requestAttempt clients", async () => {
    const discoverModule = await import("./discover");
    const attemptModule = await import("./attempt");
    const discoverSpy = vi.spyOn(discoverModule, "requestDiscover").mockResolvedValue(discoverOk);
    const attemptSpy = vi.spyOn(attemptModule, "requestAttempt").mockResolvedValue(attemptOk);

    const registry = createChatActionRegistry();
    registerDiscoverAttemptChatActions({ registry });

    await dispatchChatAction(
      { action: DISCOVER_CHAT_ACTION, params: { search: "rust" } },
      { env: enabledEnv, registry },
    );
    expect(discoverSpy).toHaveBeenCalledWith({ search: "rust" });

    await dispatchChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: validAttemptParams },
      { env: enabledEnv, registry },
    );
    expect(attemptSpy).toHaveBeenCalledWith(validAttemptParams);

    discoverSpy.mockRestore();
    attemptSpy.mockRestore();
  });

  it("defaults registration to the real ./discover and ./attempt module exports", () => {
    // Structural pin: the wire module's default path is `requestDiscover` / `requestAttempt`.
    expect(typeof requestDiscover).toBe("function");
    expect(typeof requestAttempt).toBe("function");
  });
});

describe("chatDiscoverAttemptActionsPlugin (#6837)", () => {
  it("registers discover/attempt into the shared registry on configureServer", async () => {
    const { chatDiscoverAttemptActionsPlugin } = await import("../../vite-chat-discover-attempt-actions");
    const { chatActionRegistry } = await import("../../../../packages/loopover-miner/lib/chat-action-registry.js");

    const plugin = chatDiscoverAttemptActionsPlugin();
    expect(plugin.name).toBe("loopover-miner-chat-discover-attempt-actions");

    (plugin.configureServer as () => void)();

    // configureServer fires import().then(register); wait for the shared registration to settle.
    await vi.waitFor(() => {
      expect(chatActionRegistry.has(DISCOVER_CHAT_ACTION)).toBe(true);
      expect(chatActionRegistry.has(ATTEMPT_CHAT_ACTION)).toBe(true);
    });
  });
});
