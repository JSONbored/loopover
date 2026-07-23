import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Server function wrapper around docs-source.server.ts's fumadocs-mdx lookup. Every
// docs.*.tsx route loader calls this instead of importing docs-source.server directly --
// see that file's comment for why. Going through createServerFn keeps the lookup
// server-only on both hard loads and client-side navigations: the client calls this over
// the wire instead of re-executing docs-source.server.ts (and its Node-only dependencies)
// in the browser.
//
// The import of docs-source.server is dynamic (inside the handler) rather than a static
// top-level import: this file itself is a static import in docs.$slug.tsx (and
// docs.miner-coding-agent.tsx before #8151 collapsed it into that one dynamic route), and a
// static top-level import here would drag docs-source.server.ts's eager content/docs/*.mdx
// glob into any test that merely imports a docs.*.tsx route module without invoking its
// loader -- vitest.config.ts doesn't register the fumadocs-mdx plugin needed to parse those
// files.
export const getDocPage = createServerFn({ method: "POST" })
  .inputValidator(z.object({ slugs: z.array(z.string()) }))
  .handler(async ({ data }) => {
    const { getDocPageMeta } = await import("./docs-source.server");
    return getDocPageMeta(data.slugs);
  });
