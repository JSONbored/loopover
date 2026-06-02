import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, FlaskConical, Lock } from "lucide-react";

import { DocsPage } from "@/components/site/docs-page";
import { Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/api-explorer")({
  head: () => ({
    meta: [
      { title: "API explorer — Gittensory docs" },
      {
        name: "description",
        content:
          "Use the interactive API reference and signed-in agent playground to explore decision packs, repo intelligence, branch analysis, and PR packets safely.",
      },
      { property: "og:title", content: "API explorer — Gittensory docs" },
      { property: "og:url", content: "/docs/api-explorer" },
    ],
    links: [{ rel: "canonical", href: "/docs/api-explorer" }],
  }),
  component: ApiExplorerDocs,
});

function ApiExplorerDocs() {
  return (
    <DocsPage
      eyebrow="Control panel"
      title="API explorer & agent playground"
      description="Explore the modern Gittensory API from the web app with auth, public/private boundary notes, and metadata-only request samples."
    >
      <Callout variant="safety">
        <strong>Production API only.</strong> The reference and playground call{" "}
        <code>https://gittensory-api.aethereal.dev</code> — never preview worker hosts. Sign in with
        GitHub for private endpoints; bearer tokens in Try It stay in your browser only.
      </Callout>

      <h2>Interactive API reference</h2>
      <p>
        Browse every canonical <code>/v1</code> route, copy curl/fetch/python samples, and run Try
        It requests when you have a session token. Private routes show a lock badge and require auth
        before sending.
      </p>
      <Link
        to="/api"
        className="not-prose inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm font-medium transition-colors hover:border-foreground/30"
      >
        <BookOpen className="size-4 text-mint" />
        Open API reference
        <ArrowRight className="size-4" />
      </Link>

      <h2>Agent playground</h2>
      <p>
        Signed-in users can run structured tools against the live API: decision packs, repo
        intelligence, metadata-only branch analysis, agent planning, preflight, PR packets, and
        public-safe comment previews. Request bodies never include source file contents.
      </p>
      <ul>
        <li>
          <Link to="/app/playground" className="text-mint hover:underline">
            Standalone playground
          </Link>{" "}
          — full-width tool runner with local history.
        </li>
        <li>
          <Link
            to="/app/workbench"
            search={{ tab: "playground" }}
            className="text-mint hover:underline"
          >
            Workbench tab
          </Link>{" "}
          — playground beside miner commands and digests.
        </li>
      </ul>

      <h2>Public / private boundaries</h2>
      <div className="not-prose flex items-start gap-3 rounded-token border border-border p-4">
        <Lock className="mt-0.5 size-4 shrink-0 text-mint" />
        <p className="text-token-sm text-muted-foreground">
          Private API responses may include scoreability, blockers, and evidence for authenticated
          users. Public GitHub output (comments, checks, labels) is sanitized server-side and must
          never include wallets, hotkeys, payout estimates, raw trust scores, or farming language.
        </p>
      </div>

      <h2>Quick links</h2>
      <div className="not-prose grid gap-3 sm:grid-cols-2">
        <Link
          to="/docs/branch-analysis"
          className="rounded-token border border-border p-4 transition-colors hover:border-foreground/30"
        >
          <div className="font-display font-semibold">Branch analysis</div>
          <p className="mt-1 text-token-sm text-muted-foreground">Schema and MCP flow</p>
        </Link>
        <Link
          to="/docs/privacy-security"
          className="rounded-token border border-border p-4 transition-colors hover:border-foreground/30"
        >
          <div className="inline-flex items-center gap-2 font-display font-semibold">
            <FlaskConical className="size-4 text-mint" />
            Privacy & security
          </div>
          <p className="mt-1 text-token-sm text-muted-foreground">Auth and data handling</p>
        </Link>
      </div>
    </DocsPage>
  );
}
