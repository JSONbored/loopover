import { createFileRoute } from "@tanstack/react-router";

import { PublicRepoQualityPage } from "@/components/site/public-repo-quality-page";

export const Route = createFileRoute("/repos/$owner/$repo/quality")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.owner}/${params.repo} review quality — Gittensory` },
      {
        name: "description",
        content:
          "Public, opt-in review-quality metrics for a repository: gate precision, merge outcomes, and weekly trend.",
      },
      { property: "og:title", content: `${params.owner}/${params.repo} review quality` },
      { property: "og:url", content: `/repos/${params.owner}/${params.repo}/quality` },
    ],
    links: [{ rel: "canonical", href: `/repos/${params.owner}/${params.repo}/quality` }],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { owner, repo } = Route.useParams();
  return <PublicRepoQualityPage owner={owner} repo={repo} />;
}
