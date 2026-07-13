import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import { authPlugin } from "./vite-auth";
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
    runStateApiPlugin(),
    portfolioQueueApiPlugin(),
    portfolioQueueActionsApiPlugin(),
    ledgersApiPlugin(),
    governorApiPlugin(),
    rankedCandidatesApiPlugin(),
  ],
  server: {
    // Offset from gittensory-ui (5173) so both apps can run side-by-side locally.
    port: 5174,
    strictPort: true,
  },
  preview: {
    // Offset from gittensory-ui preview (4173).
    port: 4174,
    strictPort: true,
  },
});
