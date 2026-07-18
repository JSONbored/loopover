import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import { attemptApiPlugin } from "./vite-attempt-api";
import { authPlugin } from "./vite-auth";
import { chatApiPlugin } from "./vite-chat-api";
import { chatDiscoverAttemptActionsPlugin } from "./vite-chat-discover-attempt-actions";
import { chatGovernorActionsPlugin } from "./vite-chat-governor-actions";
import { discoverApiPlugin } from "./vite-discover-api";
import { governorApiPlugin } from "./vite-governor-api";
import { ledgersApiPlugin } from "./vite-ledgers-api";
import { portfolioQueueActionsApiPlugin } from "./vite-portfolio-queue-actions-api";
import { portfolioQueueApiPlugin } from "./vite-portfolio-queue-api";
import { rankedCandidatesApiPlugin } from "./vite-ranked-candidates-api";
import { runStateApiPlugin } from "./vite-run-state-api";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
    // Must run before the API plugins below: it rejects any unauthenticated /api/* request before their own
    // middlewares are reached (#4858).
    authPlugin(),
    chatApiPlugin(),
    chatGovernorActionsPlugin(),
    chatDiscoverAttemptActionsPlugin(),
    runStateApiPlugin(),
    portfolioQueueApiPlugin(),
    portfolioQueueActionsApiPlugin(),
    ledgersApiPlugin(),
    governorApiPlugin(),
    rankedCandidatesApiPlugin(),
    discoverApiPlugin(),
    attemptApiPlugin(),
  ],
  server: {
    // Offset from loopover-ui (5173) so both apps can run side-by-side locally.
    port: 5174,
    strictPort: true,
  },
  preview: {
    // Offset from loopover-ui preview (4173).
    port: 4174,
    strictPort: true,
  },
});
