import type { Plugin } from "vite";

// Registers governor pause/resume chat actions into the shared registry on dev-server start (#6521).
// Handlers call the existing miner-ui `pauseGovernor` / `resumeGovernor` clients — same path as the Ledgers
// buttons. No new /api/governor/* route is added here.

export function chatGovernorActionsPlugin(): Plugin {
  // Register into the shared registry on BOTH dev (`configureServer`) and preview (`configurePreviewServer`)
  // start. `vite preview` — the persistent-service path in this app's README and systemd unit — only runs the
  // preview hook, so without it these actions were silently missing in production, unlike every sibling
  // vite-*-api.ts plugin (which registers for both) (#7228).
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
