import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatGovernorActionsPlugin } from "../vite-chat-governor-actions";
import { chatDiscoverAttemptActionsPlugin } from "../vite-chat-discover-attempt-actions";

// The two plugins register their chat actions via a dynamic `import("./src/lib/...")` on server start; mock those
// lib modules so the registration functions are spies. vi.hoisted keeps the spies referenceable from the hoisted
// vi.mock factories. The mock paths resolve to the SAME files the plugins import (both resolve to
// apps/loopover-miner-ui/src/lib/chat-*-actions), so a single mock intercepts the plugin's own dynamic import.
const { registerGovernorChatActions, registerDiscoverAttemptChatActions } = vi.hoisted(() => ({
  registerGovernorChatActions: vi.fn(),
  registerDiscoverAttemptChatActions: vi.fn(),
}));
vi.mock("./lib/chat-governor-actions", () => ({ registerGovernorChatActions }));
vi.mock("./lib/chat-discover-attempt-actions", () => ({ registerDiscoverAttemptChatActions }));

type HookFn = () => void;

beforeEach(() => {
  registerGovernorChatActions.mockClear();
  registerDiscoverAttemptChatActions.mockClear();
});

describe("chatGovernorActionsPlugin (#7228)", () => {
  it("registers the governor chat actions on configureServer", async () => {
    const plugin = chatGovernorActionsPlugin();
    (plugin.configureServer as HookFn)();
    await vi.waitFor(() => expect(registerGovernorChatActions).toHaveBeenCalledTimes(1));
  });

  it("REGRESSION (#7228): also registers under configurePreviewServer (the `vite preview` deployment path)", async () => {
    const plugin = chatGovernorActionsPlugin();
    expect(plugin.configurePreviewServer).toBeTypeOf("function");
    (plugin.configurePreviewServer as HookFn)();
    await vi.waitFor(() => expect(registerGovernorChatActions).toHaveBeenCalledTimes(1));
  });
});

describe("chatDiscoverAttemptActionsPlugin (#7228)", () => {
  it("registers the discover/attempt chat actions on configureServer", async () => {
    const plugin = chatDiscoverAttemptActionsPlugin();
    (plugin.configureServer as HookFn)();
    await vi.waitFor(() => expect(registerDiscoverAttemptChatActions).toHaveBeenCalledTimes(1));
  });

  it("REGRESSION (#7228): also registers under configurePreviewServer (the `vite preview` deployment path)", async () => {
    const plugin = chatDiscoverAttemptActionsPlugin();
    expect(plugin.configurePreviewServer).toBeTypeOf("function");
    (plugin.configurePreviewServer as HookFn)();
    await vi.waitFor(() => expect(registerDiscoverAttemptChatActions).toHaveBeenCalledTimes(1));
  });
});
