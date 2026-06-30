import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";
import { REES_ANALYZERS, REES_ANALYZER_NAMES, REES_PROFILES } from "@/lib/rees-analyzers";

export const Route = createFileRoute("/docs/self-hosting-rees-analyzers")({
  head: () => ({
    meta: [
      { title: "REES analyzer reference — Gittensory docs" },
      {
        name: "description",
        content:
          "Reference for every REES analyzer available to self-hosted Gittensory review engines, including analyzer names, inputs, network behavior, and findings.",
      },
      { property: "og:title", content: "REES analyzer reference — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Reference for every REES analyzer available to self-hosted Gittensory review engines, including analyzer names, inputs, network behavior, and findings.",
      },
      { property: "og:url", content: "/docs/self-hosting-rees-analyzers" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rees-analyzers" }],
  }),
  component: SelfHostingReesAnalyzers,
});

function SelfHostingReesAnalyzers() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="REES analyzer reference"
      description="Every analyzer name you can put in REES_ANALYZERS, what it inspects, what it reports, and whether it needs network or GitHub token access."
    >
      <p>
        REES runs analyzers independently. A failed analyzer is marked degraded, completed analyzers
        still return findings, and an empty result produces no user-facing brief. Use exact analyzer
        names in <code>REES_ANALYZERS</code>. A typo-only analyzer list fails closed with no
        analyzers selected. Leave <code>REES_PROFILE</code> unset for the balanced profile, or set
        <code>fast</code> during incidents to favor local and low-cost registry checks.
      </p>

      <CodeBlock
        filename=".env"
        code={`# Unset, all, or * runs the full registry.
REES_ANALYZERS=all

# A subset runs only the named analyzers.
REES_ANALYZERS=secret,actionPin,redos

# Invalid names are ignored; if none are valid, REES runs no analyzers.
REES_ANALYZERS=unknownName`}
      />

      <h2>Profiles</h2>
      <div className="not-prose divide-y divide-border border-y border-border">
        {REES_PROFILES.map((profile) => (
          <section key={profile.name} className="py-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-token-base font-medium text-foreground">{profile.name}</h3>
              {profile.default ? (
                <span className="rounded-token border border-border bg-accent/30 px-2 py-0.5 text-token-xs text-muted-foreground">
                  default
                </span>
              ) : null}
            </div>
            <dl className="mt-3 grid gap-3 text-token-sm sm:grid-cols-3">
              <div>
                <dt className="font-medium text-foreground">Cost classes</dt>
                <dd className="mt-1 text-muted-foreground">{profile.costClasses.join(", ")}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Concurrency caps</dt>
                <dd className="mt-1 font-mono text-token-xs text-muted-foreground">
                  {Object.entries(profile.concurrency)
                    .filter(([, value]) => value > 0)
                    .map(([key, value]) => `${key}:${value}`)
                    .join(", ")}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Response reserve</dt>
                <dd className="mt-1 text-muted-foreground">{profile.responseReserveMs} ms</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>

      <h2>All analyzer names</h2>
      <CodeBlock filename="REES_ANALYZERS names" code={REES_ANALYZER_NAMES.join("\n")} />

      <h2>Network and token model</h2>
      <FeatureRow
        items={[
          {
            title: "Pure analyzers",
            description:
              "secret, actionPin, redos, secretLog, and iacMisconfig work only from the diff/files sent to REES.",
          },
          {
            title: "Public registry analyzers",
            description:
              "dependency, lockfileDrift, license, installScript, heavyDependency, eol, provenance, typosquat, and nativeBuild call public package or lifecycle APIs.",
          },
          {
            title: "GitHub API analyzers",
            description:
              "codeowners, assetWeight, commitSignature, and history need author/head metadata and GitHub token forwarding when the repo is private.",
          },
        ]}
      />
      <Callout variant="safety">
        If the REES endpoint is outside your trust boundary, set{" "}
        <code>REES_FORWARD_GITHUB_TOKEN=false</code>. REES will still receive the PR diff/files when
        enabled, but token-aware analyzers will skip GitHub API reads they cannot authenticate.
      </Callout>

      <h2>Analyzer details</h2>
      <div className="not-prose divide-y divide-border border-y border-border">
        {REES_ANALYZERS.map((analyzer) => (
          <section key={analyzer.name} id={analyzer.name} className="scroll-mt-24 py-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-token-base font-medium text-foreground">{analyzer.title}</h3>
                <p className="mt-1 text-token-sm leading-token-relaxed text-muted-foreground">
                  {analyzer.docs.summary}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <code className="rounded-token border border-border bg-accent/30 px-2 py-1 font-mono text-token-xs text-foreground">
                  {analyzer.name}
                </code>
                <span className="rounded-token border border-border px-2 py-1 text-token-xs text-muted-foreground">
                  {analyzer.cost}
                </span>
              </div>
            </div>
            <dl className="mt-4 grid gap-3 text-token-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-foreground">Looks at</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.docs.looksAt}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Reports</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.docs.reports}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Network</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.docs.network}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Operational note</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.docs.notes}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Profiles</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.profiles.join(", ")}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Requirements</dt>
                <dd className="mt-1 text-muted-foreground">{analyzer.requires.join(", ")}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>

      <h2>Back to REES setup</h2>
      <p>
        Use <Link to="/docs/self-hosting-rees">REES enrichment</Link> for enablement, auth,
        troubleshooting, and where the brief appears in the review result.
      </p>
    </DocsPage>
  );
}
