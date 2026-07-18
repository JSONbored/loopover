import type { Plugin } from "vite";

// Registers discover/attempt chat actions into the shared registry on dev-server start (#6837). Handlers call
// the existing miner-ui `requestDiscover` / `requestAttempt` clients — the same POST `/api/discover` and
// `/api/attempt` path the routes already serve. No new /api/* route is added here (mirrors
// vite-chat-governor-actions.ts).

export function chatDiscoverAttemptActionsPlugin(): Plugin {
  return {
    name: "loopover-miner-chat-discover-attempt-actions",
    configureServer() {
      void import("./src/lib/chat-discover-attempt-actions").then((mod) => {
        mod.registerDiscoverAttemptChatActions();
      });
    },
  };
}
