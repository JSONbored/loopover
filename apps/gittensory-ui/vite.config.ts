// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const shouldBuildNitro = process.env.npm_lifecycle_event?.startsWith("build") ?? false;
const vendorChunks = [
  ["react-vendor", ["/node_modules/react", "/node_modules/react-dom"]],
  ["tanstack-vendor", ["/node_modules/@tanstack"]],
  ["motion-vendor", ["/node_modules/framer-motion", "/node_modules/motion"]],
  [
    "ui-vendor",
    ["/node_modules/@radix-ui", "/node_modules/cmdk", "/node_modules/sonner", "/node_modules/vaul"],
  ],
  [
    "charts-vendor",
    ["/node_modules/recharts", "/node_modules/d3-", "/node_modules/victory-vendor"],
  ],
] as const;

function manualChunks(id: string) {
  const normalized = id.replaceAll("\\", "/");
  const match = vendorChunks.find(([, paths]) => paths.some((path) => normalized.includes(path)));
  return match?.[0];
}

export default defineConfig({
  nitro: shouldBuildNitro,
  vite: {
    build: {
      rollupOptions: {
        output: { manualChunks },
      },
    },
  },
  tanstackStart: {
    client: { entry: "client" },
    // Redirect production SSR builds through src/server.ts, which wraps catastrophic errors.
    // Dev mode uses TanStack Start's default server entry.
    ...(shouldBuildNitro ? { server: { entry: "server" } } : {}),
  },
});
