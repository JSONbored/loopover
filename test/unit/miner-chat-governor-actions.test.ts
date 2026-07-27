import { describe, expect, it, vi } from "vitest";

// governor-chokepoint.js (imported transitively by chat-action-registry.js) pulls in @loopover/engine, whose
// dist is not built in the test workspace -- resolve it against source, matching the sibling miner tests.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
} from "../../packages/loopover-miner/lib/chat-action-dispatch";
import { createChatActionRegistry } from "../../packages/loopover-miner/lib/chat-action-registry";
import {
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
  isGovernorPauseChatParams,
  isGovernorResumeChatParams,
  registerGovernorChatActions,
} from "../../packages/loopover-miner/lib/chat-governor-actions";

const enabledEnv = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };

const pausedWithReason = {
  paused: true,
  reason: "investigating a bad PR",
  pausedAt: "2026-07-13T12:00:00.000Z",
};
const notPaused = { paused: false, reason: null, pausedAt: null };

describe("governor chat-action params validators (#6521)", () => {
  it("accepts optional reason for pause and rejects malformed params", () => {
    expect(isGovernorPauseChatParams(undefined)).toBe(true);
    expect(isGovernorPauseChatParams(null)).toBe(true);
    expect(isGovernorPauseChatParams({})).toBe(true);
    expect(isGovernorPauseChatParams({ reason: "hold" })).toBe(true);
    expect(isGovernorPauseChatParams({ reason: "" })).toBe(true);
    expect(isGovernorPauseChatParams({ reason: 7 })).toBe(false);
    expect(isGovernorPauseChatParams({ reason: "x", extra: 1 })).toBe(false);
    expect(isGovernorPauseChatParams("pause")).toBe(false);
    expect(isGovernorPauseChatParams([])).toBe(false);
  });

  it("accepts only empty params for resume", () => {
    expect(isGovernorResumeChatParams(undefined)).toBe(true);
    expect(isGovernorResumeChatParams({})).toBe(true);
    expect(isGovernorResumeChatParams({ reason: "nope" })).toBe(false);
    expect(isGovernorResumeChatParams("resume")).toBe(false);
  });
});

describe("registerGovernorChatActions (#6521)", () => {
  it("requires pauseGovernor and resumeGovernor callables", () => {
    expect(() =>
      registerGovernorChatActions({
        pauseGovernor: undefined as unknown as () => Promise<unknown>,
        resumeGovernor: async () => ({}),
      }),
    ).toThrow(/pauseGovernor must be a function/);
    expect(() =>
      registerGovernorChatActions({
        pauseGovernor: async () => ({}),
        resumeGovernor: undefined as unknown as () => Promise<unknown>,
      }),
    ).toThrow(/resumeGovernor must be a function/);
  });

  it("handlers call the injected pauseGovernor / resumeGovernor (not a parallel write path)", async () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = vi.fn(async (reason?: string) => ({
      ok: true,
      pauseState: { ...pausedWithReason, reason: reason ?? null },
    }));
    const resumeGovernor = vi.fn(async () => ({ ok: true, pauseState: notPaused }));
    registerGovernorChatActions({ pauseGovernor, resumeGovernor, registry });

    const pauseResult = await dispatchChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason: "investigating a bad PR" } },
      { env: enabledEnv, registry },
    );
    expect(pauseGovernor).toHaveBeenCalledTimes(1);
    expect(pauseGovernor).toHaveBeenCalledWith("investigating a bad PR");
    expect(resumeGovernor).not.toHaveBeenCalled();
    expect(pauseResult.ok).toBe(true);
    expect(pauseResult.status).toBe("dispatched");
    expect((pauseResult.result as { result: unknown }).result).toEqual({
      ok: true,
      pauseState: pausedWithReason,
    });

    const resumeResult = await dispatchChatAction(
      { action: GOVERNOR_RESUME_CHAT_ACTION, params: {} },
      { env: enabledEnv, registry },
    );
    expect(resumeGovernor).toHaveBeenCalledTimes(1);
    expect((resumeResult.result as { result: unknown }).result).toEqual({ ok: true, pauseState: notPaused });
  });

  it("covers ok:false for both pause and resume handlers", async () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = vi.fn(async () => ({ ok: false, error: "pause failed" }));
    const resumeGovernor = vi.fn(async () => ({ ok: false, error: "resume failed" }));
    registerGovernorChatActions({ pauseGovernor, resumeGovernor, registry });

    const paused = await dispatchChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION },
      { env: enabledEnv, registry },
    );
    expect((paused.result as { result: unknown }).result).toEqual({ ok: false, error: "pause failed" });

    const resumed = await dispatchChatAction(
      { action: GOVERNOR_RESUME_CHAT_ACTION },
      { env: enabledEnv, registry },
    );
    expect((resumed.result as { result: unknown }).result).toEqual({ ok: false, error: "resume failed" });
  });

  it("passes undefined when pause reason is omitted or empty", async () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = vi.fn(async () => ({ ok: true, pauseState: notPaused }));
    registerGovernorChatActions({
      pauseGovernor,
      resumeGovernor: async () => ({ ok: true, pauseState: notPaused }),
      registry,
    });

    await dispatchChatAction({ action: GOVERNOR_PAUSE_CHAT_ACTION }, { env: enabledEnv, registry });
    expect(pauseGovernor).toHaveBeenLastCalledWith(undefined);

    await dispatchChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason: "" } },
      { env: enabledEnv, registry },
    );
    expect(pauseGovernor).toHaveBeenLastCalledWith(undefined);
  });

  it("stays inert when the shared action-dispatch flag is off", async () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = vi.fn(async () => ({ ok: true, pauseState: notPaused }));
    registerGovernorChatActions({
      pauseGovernor,
      resumeGovernor: async () => ({ ok: true, pauseState: notPaused }),
      registry,
    });

    const result = await dispatchChatAction({ action: GOVERNOR_PAUSE_CHAT_ACTION }, { env: {}, registry });
    expect(result).toEqual({ ok: false, status: "disabled", action: GOVERNOR_PAUSE_CHAT_ACTION });
    expect(pauseGovernor).not.toHaveBeenCalled();
  });

  it("is idempotent on the same registry", () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = async () => ({ ok: true, pauseState: notPaused });
    const resumeGovernor = async () => ({ ok: true, pauseState: notPaused });
    registerGovernorChatActions({ pauseGovernor, resumeGovernor, registry });
    registerGovernorChatActions({ pauseGovernor, resumeGovernor, registry });
    expect(registry.names()).toEqual([GOVERNOR_PAUSE_CHAT_ACTION, GOVERNOR_RESUME_CHAT_ACTION]);
  });

  it("rejects invalid params without invoking the write", async () => {
    const registry = createChatActionRegistry();
    const pauseGovernor = vi.fn(async () => ({ ok: true, pauseState: notPaused }));
    registerGovernorChatActions({
      pauseGovernor,
      resumeGovernor: async () => ({ ok: true, pauseState: notPaused }),
      registry,
    });

    const result = await dispatchChatAction(
      { action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason: 7 } },
      { env: enabledEnv, registry },
    );
    expect(result).toEqual({ ok: false, status: "invalid_params", action: GOVERNOR_PAUSE_CHAT_ACTION });
    expect(pauseGovernor).not.toHaveBeenCalled();
  });
});

describe("shared flag constant (#6521)", () => {
  it("uses the scaffolding enable value (no governor-specific flag)", () => {
    expect(CHAT_ACTION_DISPATCH_ENABLE_VALUE).toBe("enabled");
    expect(CHAT_ACTION_DISPATCH_FLAG).toBe("LOOPOVER_MINER_CHAT_ACTIONS");
  });
});
