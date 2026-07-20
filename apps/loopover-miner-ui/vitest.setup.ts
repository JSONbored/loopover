import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver -- recharts' ResponsiveContainer (used by ChartContainer on the ledgers
// claims chart, #6832) needs one to mount at all. A no-op stub is the standard fix: it never actually
// resizes in a test DOM, and no test here asserts on a resize-driven re-render, only on the rendered markup.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// #7576: restore jsdom's Web Storage on Node 25+ -- same fix as apps/loopover-ui/vitest.setup.ts, and
// needed independently here because `theme-toggle.test.tsx` reads localStorage. Node 25 shipped a native
// `globalThis.localStorage` that evaluates to `undefined` without `--localstorage-file`
// (nodejs/node#60303), and vitest's jsdom environment then skips copying jsdom's real Storage because the
// key already "exists" (vitest-dev/vitest#8757, closed as non-LTS-unsupported). Reachable via the raw
// JSDOM instance vitest exposes as `globalThis.jsdom`. No-op on Node <=24, where the key is absent and
// jsdom's Storage is copied normally.
const jsdomWindow = (globalThis as { jsdom?: { window?: Record<string, unknown> } }).jsdom?.window;
for (const storageKey of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[storageKey] !== undefined || jsdomWindow?.[storageKey] === undefined) continue;
  Object.defineProperty(globalThis, storageKey, {
    value: jsdomWindow[storageKey],
    configurable: true,
    writable: true,
  });
}

// #7075: ChatConversation wires handlePortfolioQueueChatCommand, which imports chat-action-registry →
// governor-chokepoint → governor-ledger → node:sqlite. jsdom/Vite cannot bundle that builtin (same twin
// pattern as chat-governor-actions.test.tsx / chat-portfolio-queue-actions.test.tsx).
const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

function createBrowserSafeRegistry() {
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
      if (
        typeof definition.handler !== "function" ||
        !(definition.handler as { [k: symbol]: unknown })[GOVERNOR_GATED]
      ) {
        throw new Error(`registerChatAction("${name}"): handler must be produced by governorGatedHandler()`);
      }
      if (actions.has(name)) {
        // Idempotent enough for shared registration across tests that remount ChatConversation.
        return definition;
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

const sharedBrowserRegistry = createBrowserSafeRegistry();

vi.mock("../../packages/loopover-miner/lib/chat-action-registry.js", () => {
  function isGovernorGatedHandler(handler: unknown): boolean {
    return typeof handler === "function" && (handler as { [k: symbol]: unknown })[GOVERNOR_GATED] === true;
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

  return {
    createChatActionRegistry: createBrowserSafeRegistry,
    governorGatedHandler,
    isGovernorGatedHandler,
    chatActionRegistry: sharedBrowserRegistry,
    registerChatAction: (name: string, definition: Parameters<typeof sharedBrowserRegistry.register>[1]) =>
      sharedBrowserRegistry.register(name, definition),
  };
});

vi.mock("../../packages/loopover-miner/lib/chat-action-dispatch.js", () => ({
  CHAT_ACTION_DISPATCH_FLAG: "LOOPOVER_MINER_CHAT_ACTIONS",
  CHAT_ACTION_DISPATCH_ENABLE_VALUE: "enabled",
  isChatActionDispatchEnabled: (env: Record<string, string | undefined> = {}) =>
    env.LOOPOVER_MINER_CHAT_ACTIONS === "enabled",
  dispatchChatAction: async (
    request: { action?: string; params?: unknown; governorInput?: unknown },
    options: { env?: Record<string, string | undefined>; registry?: { get: (name: string) => unknown } } = {},
  ) => {
    const env = options.env ?? {};
    if (env.LOOPOVER_MINER_CHAT_ACTIONS !== "enabled") {
      return { ok: false, status: "disabled" };
    }
    const registry = options.registry ?? sharedBrowserRegistry;
    const entry = registry.get(request.action ?? "") as
      { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> } | undefined;
    if (!entry) return { ok: false, status: "unknown_action", action: request.action };
    if (!entry.paramsValidator(request.params)) {
      return { ok: false, status: "invalid_params", action: request.action };
    }
    const result = await entry.handler(request);
    return { ok: true, status: "dispatched", action: request.action, result };
  },
}));
