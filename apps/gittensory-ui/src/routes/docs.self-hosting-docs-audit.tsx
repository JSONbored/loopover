import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";
import {
  LOOSE_DOCS_ROWS,
  SELFHOST_DOCS_PAGES,
  SELFHOST_DOCS_VALIDATION_COMMANDS,
  SELFHOST_SOURCE_OF_TRUTH_ROWS,
} from "@/lib/selfhost-docs-audit";

export const Route = createFileRoute("/docs/self-hosting-docs-audit")({
  head: () => ({
    meta: [
      { title: "Self-host docs accuracy audit — Gittensory docs" },
      {
        name: "description",
        content:
          "Checklist mapping self-host website docs to runtime sources of truth — compose defaults, env vars, releases, observability, backup, and drift guards.",
      },
      { property: "og:title", content: "Self-host docs accuracy audit — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Checklist mapping self-host website docs to runtime sources of truth — compose defaults, env vars, releases, observability, backup, and drift guards.",
      },
      { property: "og:url", content: "/docs/self-hosting-docs-audit" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-docs-audit" }],
  }),
  component: SelfHostingDocsAudit,
});

function SelfHostingDocsAudit() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Docs accuracy audit"
      description="Before a self-host release, use this checklist to confirm website docs still match runtime defaults. Each row links a docs page to the files and CI drift guards that must stay aligned."
    >
      <Callout variant="note" title="Scope (#1829)">
        This page is the in-repo paper trail for the self-host docs audit under roadmap{" "}
        <a href="https://github.com/JSONbored/gittensory/issues/1819">#1819</a>. REES analyzer
        metadata generation is tracked separately on the REES roadmap — the analyzer reference page
        covers names and shapes; auto-generated metadata tables are out of scope here.
      </Callout>

      <h2>Website docs navigation</h2>
      <p>
        Self-hosting docs live on the website under{" "}
        <Link to="/docs/maintainer-self-hosting">Self-hosted reviews</Link>. Every child page below
        is linked from that index and from the maintainer docs hub.
      </p>
      <ul>
        {SELFHOST_DOCS_PAGES.map((page) => (
          <li key={page.path}>
            <Link to={page.path}>{page.title}</Link> —{" "}
            <code>{`apps/gittensory-ui/src/routes/${page.routeFile}`}</code>
          </li>
        ))}
      </ul>

      <h2>Source-of-truth checklist</h2>
      <p>
        When you change runtime behavior, update the docs page <strong>and</strong> extend the drift
        guard test when one exists. Env vars must stay aligned with{" "}
        <code>npm run selfhost:env-reference</code>; observability configs with{" "}
        <code>npm run selfhost:validate-observability</code>.
      </p>
      <div className="not-prose overflow-x-auto">
        <table className="w-full border-collapse text-left text-token-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-4 font-medium">Topic</th>
              <th className="py-2 pr-4 font-medium">Runtime sources</th>
              <th className="py-2 pr-4 font-medium">Docs page</th>
              <th className="py-2 pr-4 font-medium">Drift guard</th>
            </tr>
          </thead>
          <tbody>
            {SELFHOST_SOURCE_OF_TRUTH_ROWS.map((row) => (
              <tr key={row.topic} className="border-b border-border align-top">
                <td className="py-3 pr-4">
                  <div className="font-medium text-foreground">{row.topic}</div>
                  {row.notes ? (
                    <p className="mt-1 text-token-xs text-muted-foreground">{row.notes}</p>
                  ) : null}
                </td>
                <td className="py-3 pr-4">
                  <ul className="list-none space-y-1 p-0">
                    {row.runtimeSources.map((source) => (
                      <li key={source}>
                        <code>{source}</code>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="py-3 pr-4">
                  <Link to={row.docsPath}>{row.docsPath.replace("/docs/", "")}</Link>
                </td>
                <td className="py-3 pr-4">
                  {row.driftGuard ? <code>{`test/unit/${row.driftGuard}`}</code> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Defaults, optional services, and experimental surfaces</h2>
      <ul>
        <li>
          <strong>Core stack (default):</strong> gittensory + Redis + SQLite on the mounted data
          volume; <code>SELFHOST_DEPLOYMENT_MODE=dry-run</code> in{" "}
          <code>.env.selfhost.example</code>.
        </li>
        <li>
          <strong>Optional profiles:</strong> Postgres, REES sidecar, observability (Prometheus,
          Grafana, OTEL, Tempo, Loki), and backup — each documented on its concern page; none are
          required for a first healthy instance.
        </li>
        <li>
          <strong>Sentry:</strong> opt-in and off by default — set an operator-owned{" "}
          <code>SENTRY_DSN</code> or mount <code>SENTRY_DSN_FILE</code>; see{" "}
          <Link to="/docs/self-hosting-operations">Operations</Link>.
        </li>
        <li>
          <strong>AI / RAG / REES:</strong> off in the starter env until webhook delivery and
          deterministic review are verified; each has explicit enablement switches.
        </li>
        <li>
          <strong>Operator-owned paths:</strong> <code>gittensory-config/</code>,{" "}
          <code>gittensory-data</code>, and secrets via <code>.env</code> or <code>*_FILE</code>{" "}
          mounts — never baked into images.
        </li>
      </ul>

      <h2>Loose docs consolidation</h2>
      <p>
        Root-level markdown outside the website must either link to the canonical website page or
        stay intentionally separate (convergence runbooks, contributor notes). Do not duplicate
        self-host operator instructions in a second place that will drift.
      </p>
      <ul>
        {LOOSE_DOCS_ROWS.map((row) => (
          <li key={row.path}>
            <code>{row.path}</code> — {row.role}{" "}
            {row.websiteDocsPath ? (
              <>
                (canonical: <Link to={row.websiteDocsPath}>{row.websiteDocsPath}</Link>)
              </>
            ) : null}
            {row.notes ? <> — {row.notes}</> : null}
          </li>
        ))}
      </ul>

      <h2>Validation commands</h2>
      <p>Run from the repo root before merging docs or cutting an orb release:</p>
      <CodeBlock code={SELFHOST_DOCS_VALIDATION_COMMANDS.join("\n")} />
      <Callout>
        Spot-check documented shell commands against the current <code>docker-compose.yml</code>{" "}
        profiles and release scripts when you touch operator-facing prose — CI drift guards cover
        the highest-risk surfaces but not every copy-pasted example.
      </Callout>
    </DocsPage>
  );
}
