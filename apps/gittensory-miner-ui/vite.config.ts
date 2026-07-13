import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import { ledgersApiPlugin } from "./vite-ledgers-api";
import { portfolioQueueApiPlugin } from "./vite-portfolio-queue-api";
import { runStateApiPlugin } from "./vite-run-state-api";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
    runStateApiPlugin(),
    portfolioQueueApiPlugin(),
    ledgersApiPlugin(),
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
