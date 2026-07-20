import { createFileRoute } from "@tanstack/react-router";

import { FairnessReportPage } from "@/components/site/fairness-report-page";

export const Route = createFileRoute("/fairness")({
  head: () => ({
    meta: [
      { title: "Fairness report — LoopOver" },
      {
        name: "description",
        content:
          "Reversal-grounded decision accuracy and anti-gaming detection across the ORB fleet, updated live.",
      },
      { property: "og:title", content: "LoopOver fairness report" },
      {
        property: "og:description",
        content:
          "Is ORB treating contributors fairly? Aggregate accuracy and anti-gaming counts, no PR content or contributor identities.",
      },
      { property: "og:url", content: "/fairness" },
    ],
    links: [{ rel: "canonical", href: "/fairness" }],
  }),
  component: FairnessReportPage,
});
