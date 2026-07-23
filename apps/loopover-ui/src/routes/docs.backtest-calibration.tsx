import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/backtest-calibration.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives -- not fumadocs-ui's
// bundled components. See docs-source.server.ts's comment for why the loader below resolves only a
// plain, serializable path string.
export const Route = createFileRoute("/docs/backtest-calibration")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["backtest-calibration"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Backtest & calibration — LoopOver docs" },
      {
        name: "description",
        content:
          "How LoopOver measures whether its own review rules are right, and backtests threshold and logic changes against real recorded history before they ship.",
      },
      { property: "og:title", content: "Backtest & calibration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How LoopOver measures whether its own review rules are right, and backtests threshold and logic changes against real recorded history before they ship.",
      },
      { property: "og:url", content: "/docs/backtest-calibration" },
    ],
    links: [{ rel: "canonical", href: "/docs/backtest-calibration" }],
  }),
  component: BacktestCalibrationDoc,
});

function BacktestCalibrationDoc() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Core concepts" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
