import type { Plugin } from "vite";

// Registers discover/attempt chat actions into the shared registry on server start (#6837). Handlers call the
// existing miner-ui `requestDiscover` / `requestAttempt` clients — the same POST `/api/discover` and
// `/api/attempt` path the routes already serve. No new /api/* route is added here (mirrors
// vite-chat-governor-actions.ts).
//
// Registered from BOTH configureServer AND configurePreviewServer (#7228): `vite preview` — the mode the
// README's "persistent service" path and systemd/loopover-miner-ui.service.example actually run — only fires
// configurePreviewServer, so registering on configureServer alone left the chat-action registry empty under
// preview and every discover/attempt chat command dispatched as "unknown_action".
// registerDiscoverAttemptChatActions is already idempotent, so calling it from both hooks is safe.
export function chatDiscoverAttemptActionsPlugin(): Plugin {
  const register = () => {
    void import("./src/lib/chat-discover-attempt-actions").then((mod) => {
      mod.registerDiscoverAttemptChatActions();
    });
  };
  return {
    name: "loopover-miner-chat-discover-attempt-actions",
    configureServer() {
      register();
    },
    configurePreviewServer() {
      register();
    },
  };
}
