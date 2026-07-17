import { describe, expect, it, vi } from "vitest";

// chat-action-dispatch.js -> chat-action-registry.js -> governor-chokepoint.js -> @loopover/engine, whose dist
// is not built in the test workspace; resolve it against source like the sibling miner tests.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
  isChatActionDispatchEnabled,
} from "../../packages/loopover-miner/lib/chat-action-dispatch.js";
import {
  createChatActionRegistry,
  governorGatedHandler,
} from "../../packages/loopover-miner/lib/chat-action-registry.js";

const enabledEnv = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };
const allowGate = () => ({ decision: { stage: "allow" } });

function registryWith(name: string, paramsValidator: (params: unknown) => boolean, run = () => "written") {
  const registry = createChatActionRegistry();
  registry.register(name, { paramsValidator, handler: governorGatedHandler(run, { evaluateGate: allowGate }) });
  return registry;
}

describe("isChatActionDispatchEnabled (#6519)", () => {
  it("is disabled when unset, empty, or set to any non-enable value", () => {
    expect(isChatActionDispatchEnabled({})).toBe(false);
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "" })).toBe(false);
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "true" })).toBe(false);
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "1" })).toBe(false);
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "ENABLED" })).toBe(false);
  });

  it("is enabled only for the exact enable value (trimmed)", () => {
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "enabled" })).toBe(true);
    expect(isChatActionDispatchEnabled({ [CHAT_ACTION_DISPATCH_FLAG]: "  enabled  " })).toBe(true);
  });
});

describe("dispatchChatAction (#6519)", () => {
  it("short-circuits with a disabled result and never touches the registry when the flag is off", async () => {
    const registry = {
      has: () => {
        throw new Error("registry must not be consulted while the flag is off");
      },
      get: () => {
        throw new Error("registry must not be consulted while the flag is off");
      },
    };
    const result = await dispatchChatAction(
      { action: "portfolio.release", params: {} },
      // @ts-expect-error trap registry proving the flag gate runs before any lookup
      { env: {}, registry },
    );
    expect(result).toEqual({ ok: false, status: "disabled", action: "portfolio.release" });
  });

  it("reports action:null in the disabled result when the request omits an action", async () => {
    const result = await dispatchChatAction({}, { env: {} });
    expect(result).toEqual({ ok: false, status: "disabled", action: null });
  });

  it("defaults env to process.env and the shared (empty) registry when options are omitted", async () => {
    // process.env has no enable flag by default -> disabled, exercising the `options.env ?? process.env` default.
    const disabled = await dispatchChatAction({ action: "demo" });
    expect(disabled).toEqual({ ok: false, status: "disabled", action: "demo" });

    // With the flag flipped on in the real environment and no registry override, dispatch reads the shared
    // empty registry -> unknown_action, exercising the `options.registry ?? chatActionRegistry` default.
    const prev = process.env[CHAT_ACTION_DISPATCH_FLAG];
    process.env[CHAT_ACTION_DISPATCH_FLAG] = CHAT_ACTION_DISPATCH_ENABLE_VALUE;
    try {
      const unknown = await dispatchChatAction({ action: "demo" });
      expect(unknown).toEqual({ ok: false, status: "unknown_action", action: "demo" });
    } finally {
      if (prev === undefined) delete process.env[CHAT_ACTION_DISPATCH_FLAG];
      else process.env[CHAT_ACTION_DISPATCH_FLAG] = prev;
    }
  });

  it("rejects an unknown action when enabled", async () => {
    const registry = createChatActionRegistry();
    const result = await dispatchChatAction({ action: "nope" }, { env: enabledEnv, registry });
    expect(result).toEqual({ ok: false, status: "unknown_action", action: "nope" });
  });

  it("rejects a request whose action is not a string", async () => {
    const registry = createChatActionRegistry();
    const result = await dispatchChatAction(
      { action: 7 as unknown as string },
      { env: enabledEnv, registry },
    );
    expect(result).toEqual({ ok: false, status: "unknown_action", action: null });
  });

  it("dispatches to the handler when the params-validator passes", async () => {
    const run = vi.fn(() => "did-write");
    const registry = createChatActionRegistry();
    registry.register("demo", {
      paramsValidator: (params) => params !== null && typeof params === "object",
      handler: governorGatedHandler(run, { evaluateGate: allowGate }),
    });
    const result = await dispatchChatAction({ action: "demo", params: { a: 1 } }, { env: enabledEnv, registry });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      status: "dispatched",
      action: "demo",
      result: { ok: true, status: "executed", decision: { stage: "allow" }, result: "did-write" },
    });
  });

  it("rejects with invalid_params when the validator returns falsy and never invokes the handler", async () => {
    const run = vi.fn(() => "did-write");
    const registry = registryWith("demo", (params) => typeof params === "string", run);
    const result = await dispatchChatAction({ action: "demo", params: { a: 1 } }, { env: enabledEnv, registry });
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, status: "invalid_params", action: "demo" });
  });

  it("treats a throwing validator as a rejection (fail closed), not a dispatch error", async () => {
    const run = vi.fn(() => "did-write");
    const registry = createChatActionRegistry();
    registry.register("demo", {
      paramsValidator: () => {
        throw new Error("bad params shape");
      },
      handler: governorGatedHandler(run, { evaluateGate: allowGate }),
    });
    const result = await dispatchChatAction({ action: "demo", params: {} }, { env: enabledEnv, registry });
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, status: "invalid_params", action: "demo", error: "bad params shape" });
  });

  it("stringifies a non-Error thrown by the validator", async () => {
    const registry = createChatActionRegistry();
    registry.register("demo", {
      paramsValidator: () => {
        throw "boom";
      },
      handler: governorGatedHandler(() => "x", { evaluateGate: allowGate }),
    });
    const result = await dispatchChatAction({ action: "demo", params: {} }, { env: enabledEnv, registry });
    expect(result).toEqual({ ok: false, status: "invalid_params", action: "demo", error: "boom" });
  });

  it("fails closed with handler_error when the handler throws, not an unhandled rejection (#6989)", async () => {
    const registry = registryWith("demo", () => true, () => {
      throw new Error("network down");
    });
    const result = await dispatchChatAction({ action: "demo", params: {} }, { env: enabledEnv, registry });
    // Distinct from invalid_params so a caller can tell an execution failure from a validation failure.
    expect(result).toEqual({ ok: false, status: "handler_error", action: "demo", error: "network down" });
  });

  it("stringifies a non-Error thrown by the handler (#6989)", async () => {
    const registry = registryWith("demo", () => true, () => {
      throw "kaboom";
    });
    const result = await dispatchChatAction({ action: "demo", params: {} }, { env: enabledEnv, registry });
    expect(result).toEqual({ ok: false, status: "handler_error", action: "demo", error: "kaboom" });
  });
});
