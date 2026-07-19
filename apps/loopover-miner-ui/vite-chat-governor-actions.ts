import type { Plugin } from "vite";

// Registers governor pause/resume chat actions into the shared registry on server start (#6521). Handlers call
// the existing miner-ui `pauseGovernor` / `resumeGovernor` clients — same path as the Ledgers buttons. No new
// /api/governor/* route is added here.
//
// Registered from BOTH configureServer AND configurePreviewServer (#7228): `vite preview` — the mode the
// README's "persistent service" path and systemd/loopover-miner-ui.service.example actually run — only fires
// configurePreviewServer, so registering on configureServer alone left the chat-action registry empty under
// preview and every governor chat command dispatched as "unknown_action". registerGovernorChatActions is already
// idempotent, so calling it from both hooks is safe.
export function chatGovernorActionsPlugin(): Plugin {
  const register = () => {
    void import("./src/lib/chat-governor-actions").then((mod) => {
      mod.registerGovernorChatActions();
    });
  };
  return {
    name: "loopover-miner-chat-governor-actions",
    configureServer() {
      register();
    },
    configurePreviewServer() {
      register();
    },
  };
}
