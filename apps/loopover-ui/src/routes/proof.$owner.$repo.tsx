import { createFileRoute } from "@tanstack/react-router";

import { PublicProofPage } from "@/components/site/public-proof-page";

export const Route = createFileRoute("/proof/$owner/$repo")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.owner}/${params.repo} review proof — LoopOver` },
      {
        name: "description",
        content:
          "Public, independently checkable evidence for a repository's automated review record: decision count, accuracy with its interval, live ledger verification, and the external anchor.",
      },
      { property: "og:title", content: `${params.owner}/${params.repo} review proof` },
      { property: "og:url", content: `/proof/${params.owner}/${params.repo}` },
    ],
    links: [{ rel: "canonical", href: `/proof/${params.owner}/${params.repo}` }],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { owner, repo } = Route.useParams();
  return <PublicProofPage owner={owner} repo={repo} />;
}
