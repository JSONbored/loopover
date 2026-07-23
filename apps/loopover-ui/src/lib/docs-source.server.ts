import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

// Server-only (the .server.ts suffix keeps this out of the client bundle, see
// config.server.ts). `collections/server` is fumadocs-mdx's generated, filesystem-backed
// runtime -- it globs every content/docs/*.mdx file eagerly and depends on Node's `path`
// module, which doesn't exist in the browser. TanStack Router route loaders run on both
// the server (hard loads) AND in the browser (client-side navigations), so this module
// must never be imported directly from a route loader -- only through getDocPageMeta()
// below, called via the createServerFn in docs-source.functions.ts, so a client-side
// navigation fetches the result over the wire instead of re-executing this module.
export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export function getDocPageMeta(slugs: string[]) {
  const page = docsSource.getPage(slugs);
  if (!page) return null;
  return {
    path: page.path,
    title: page.data.title,
    description: page.data.description,
    eyebrow: page.data.eyebrow,
  };
}
