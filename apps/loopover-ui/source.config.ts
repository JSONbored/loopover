import { defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

// eyebrow (#8151): the one genuinely per-page datum the old per-route docs.<slug>.tsx files hard-coded
// as a JSX prop (e.g. eyebrow="Configuration") instead of deriving it from anything -- moved into
// frontmatter so the single dynamic docs.$slug.tsx route can read it the same way it reads
// title/description, with no per-page route file left to hold it. Required (not optional): every real
// content/docs/*.mdx page has always rendered one, and a page silently missing its eyebrow badge would
// be a content regression fumadocs-mdx's own build should catch, not something to render as blank.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      eyebrow: z.string(),
    }),
  },
});
