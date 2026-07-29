import browserCollections from "collections/browser";

import { docsMdxComponents } from "@/lib/docs-mdx-components";

// SPIKE (#6037): the client-safe counterpart to docs-source.ts (which is server-only --
// its `collections/server` import crashes if bundled into the client, see docs-source.ts).
// `collections/browser` compiles each .mdx file into its own lazily-imported ES module with
// no Node `path` dependency, so it's safe in both SSR and client bundles. A route pairs this
// with a server `loader` that resolves only the plain, serializable `page.path` string via
// docs-source.ts -- never the live MDX component itself -- then this client loader turns that
// path into the actual rendered content on both sides.
export const docsClientLoader = browserCollections.docs.createClientLoader({
  // No props: that leaves the loader's `Props` as `undefined`, which is what makes `useContent(path)`
  // callable without a props argument (#9588). `useContent` returns react NODES, where `getComponent`
  // returns a component -- and minting a component inside a render is what react-hooks/static-components
  // rejects, since a fresh identity each render remounts the whole subtree.
  component({ default: MDXContent }) {
    return <MDXContent components={docsMdxComponents} />;
  },
});
