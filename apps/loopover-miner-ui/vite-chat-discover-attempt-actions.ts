import type { Plugin } from "vite";

// Registers discover/attempt chat actions into the shared registry on dev-server start (#6837). Handlers call
// the existing miner-ui `requestDiscover` / `requestAttempt` clients — the same POST `/api/discover` and
// `/api/attempt` path the routes already serve. No new /api/* route is added here (mirrors
// vite-chat-governor-actions.ts).

export function chatDiscoverAttemptActionsPlugin(): Plugin {
  // Register on BOTH dev (`configureServer`) and preview (`configurePreviewServer`) start — `vite preview` (the
  // persistent-service path in this app's README and systemd unit) only runs the preview hook, so without it
  // these actions were silently missing in production, unlike every sibling vite-*-api.ts plugin (#7228).
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
