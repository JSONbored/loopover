// Bundle the self-host Node entry (src/server.ts) into dist/server.mjs.
//   default       → node_modules stay external (resolved at runtime; fast local dev rebuilds).
//   --all / SELFHOST_BUNDLE_ALL=1 → bundle EVERYTHING into one self-contained file (the Docker image needs no
//                   node_modules → a ~10× smaller image). node: builtins stay external (platform:node).
//   source maps are always emitted so release builds can inject/upload matching Sentry artifacts.
// In both modes the Cloudflare-only specifiers resolve to Node stubs via the plugin (precedence over external),
// so the bundle has zero `cloudflare:*` imports.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleAll = process.env.SELFHOST_BUNDLE_ALL === "1" || process.argv.includes("--all");

await esbuild.build({
  entryPoints: [resolve(root, "src/server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(root, "dist/server.mjs"),
  sourcemap: true,
  sourcesContent: true,
  sourceRoot: "/app/dist",
  // External: nothing (bundle all) vs every package (external). node: builtins are always external on node.
  // sharp (#4370) is ALWAYS external even in --all mode: it ships a native per-platform binary esbuild
  // cannot bundle, unlike sharp's own JS glue code -- the Dockerfile installs it separately into the
  // runtime image (see the runtime-base stage).
  ...(bundleAll ? { external: ["sharp"] } : { packages: "external" }),
  // Bundling CJS deps into an ESM output needs require/__dirname/__filename shimmed (some deps call them).
  ...(bundleAll
    ? {
        banner: {
          js: [
            "import { createRequire as __createRequire } from 'node:module';",
            "import { fileURLToPath as __fileURLToPath } from 'node:url';",
            "import { dirname as __pathDirname } from 'node:path';",
            "const require = __createRequire(import.meta.url);",
            "const __filename = __fileURLToPath(import.meta.url);",
            "const __dirname = __pathDirname(__filename);",
          ].join("\n"),
        },
      }
    : {}),
  plugins: [
    {
      name: "selfhost-stubs",
      setup(build) {
        // Cloudflare-only modules → Node stubs (their features are inert/degraded on self-host).
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve(root, "src/selfhost/cf-workers-shim.ts") }));
        build.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/puppeteer.ts") }));
        build.onResolve({ filter: /^agents\/mcp$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/agents-mcp.ts") }));
        // Worker-safe no-op → real pixel-diff (pixelmatch/pngjs need Node Buffer, forbidden in the Worker
        // bundle by test/unit/worker-entry-boundary.test.ts). Exact match: capture.ts is the only value
        // importer, always as "./pixel-diff" (same-directory sibling) — the stub's own `import type` back to
        // the original is erased before bundling and never reaches this resolver.
        build.onResolve({ filter: /^\.\/pixel-diff$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/pixel-diff.ts") }));
        // Same pattern for scroll-through GIF assembly (#3612) — pngjs decode + gifenc encode need Node Buffer.
        build.onResolve({ filter: /^\.\/scroll-gif$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/scroll-gif.ts") }));
        // Same pattern for vision-image downscaling (#4370) — sharp is a native binding, Worker-unsafe.
        build.onResolve({ filter: /^\.\/image-downscale$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/image-downscale.ts") }));
      },
    },
  ],
  logLevel: "info",
});
