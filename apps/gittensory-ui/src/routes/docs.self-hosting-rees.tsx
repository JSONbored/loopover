import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";
import { REES_ANALYZER_NAMES } from "@/lib/rees-analyzers";

export const Route = createFileRoute("/docs/self-hosting-rees")({
  head: () => ({
    meta: [
      { title: "REES enrichment — Gittensory docs" },
      {
        name: "description",
        content:
          "Configure REES for self-hosted Gittensory reviews, including service auth, analyzer selection, result visibility, and troubleshooting.",
      },
      { property: "og:title", content: "REES enrichment — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Configure REES for self-hosted Gittensory reviews, including service auth, analyzer selection, result visibility, and troubleshooting.",
      },
      { property: "og:url", content: "/docs/self-hosting-rees" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rees" }],
  }),
  component: SelfHostingRees,
});

function SelfHostingRees() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="REES enrichment"
      description="REES runs external or heavier analyzers and returns a public-safe brief that the AI reviewer can use."
    >
      <h2>Where REES fits</h2>
      <p>
        REES fires inside the AI review path. It is not a separate status check, dashboard report,
        or PR attachment. When it returns a non-empty <code>promptSection</code>, the engine folds
        that brief into the AI reviewer prompt. The final result is seen only through the normal AI
        review summary, blockers, risks, nits, and decision.
      </p>
      <Callout variant="note">
        A 200 response with no findings can produce no rendered brief. That is expected: the review
        proceeds as if REES had no useful extra context for that PR.
      </Callout>

      <h2>When it fires</h2>
      <FeatureRow
        items={[
          {
            title: "AI review is running",
            description:
              "The PR must reach the AI review path: review mode is not off, the author is reviewable, and the PR has a head SHA.",
          },
          {
            title: "Repo is allowlisted",
            description:
              "The repo must be listed in GITTENSORY_REVIEW_REPOS, the same cutover allowlist used by the other per-PR review features.",
          },
          {
            title: "REES is enabled",
            description:
              "GITTENSORY_REVIEW_ENRICHMENT must be truthy and REES_URL must be set. Otherwise no REES request is made.",
          },
          {
            title: "Service auth matches",
            description:
              "If the service has REES_SHARED_SECRET configured, the engine must send the same bearer secret.",
          },
        ]}
      />

      <h2>Engine configuration</h2>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_REPOS=owner/repo
GITTENSORY_REVIEW_ENRICHMENT=true
REES_URL=https://enrichment.example.internal
REES_SHARED_SECRET=<shared-secret>
REES_TIMEOUT_MS=8000
REES_PROFILE=balanced
REES_FORWARD_GITHUB_TOKEN=false
REES_ANALYZERS=all`}
      />
      <FeatureRow
        items={[
          {
            title: "GITTENSORY_REVIEW_ENRICHMENT",
            description: "Global switch. Must be truthy and REES_URL must be set.",
          },
          {
            title: "GITTENSORY_REVIEW_REPOS",
            description: "Repo allowlist. REES only runs for allowlisted repos.",
          },
          {
            title: "REES_SHARED_SECRET",
            description:
              "Bearer secret shared with the REES service. Keep it out of code and images.",
          },
          {
            title: "REES_TIMEOUT_MS",
            description: "Request timeout. Defaults to 8000 ms and is clamped to at least 1000 ms.",
          },
          {
            title: "REES_PROFILE",
            description:
              "Optional analyzer profile. balanced is the default; fast favors local/registry checks during incidents; deep allows larger per-class budgets.",
          },
          {
            title: "REES_FORWARD_GITHUB_TOKEN",
            description:
              "Defaults to false. Set true only when REES_URL is inside your trust boundary and token-aware analyzers need CODEOWNERS or blob-size reads.",
          },
        ]}
      />

      <h2>Self-hosting REES</h2>
      <p>
        The docker-compose stack in the repo root can run REES for you instead of pointing{" "}
        <code>REES_URL</code> at a managed or external instance. Start it alongside the engine with
        the <code>rees</code> profile:
      </p>
      <CodeBlock lang="bash" code={`docker compose --profile rees up -d`} />
      <p>
        REES is not published to the host — the engine reaches it only over the compose network.
        Point the engine at it and generate a fresh shared secret; do not reuse a secret from any
        other REES instance (for example a managed Railway deployment) you also run:
      </p>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_ENRICHMENT=true
REES_URL=http://rees:8080
REES_SHARED_SECRET=<generate-a-new-shared-secret>`}
      />
      <p>
        No <code>SENTRY_*</code> variables are required for a working local REES. Set them only if
        you want REES error reporting — see "Service configuration" below for the variables REES
        reads, and add them for the <code>rees</code> service through a{" "}
        <code>docker-compose.override.yml</code> rather than the root <code>.env</code>: REES reads
        the same <code>SENTRY_DSN</code> name the main engine uses, so forwarding the whole{" "}
        <code>.env</code> file would point REES's error reporting at the engine's Sentry project
        instead of a dedicated one.
      </p>

      <h2>Disable cleanly</h2>
      <p>
        Set <code>GITTENSORY_REVIEW_ENRICHMENT=false</code> to turn off REES for the whole instance.
        To keep REES configured but prevent a repo from using it, remove that repo from{" "}
        <code>GITTENSORY_REVIEW_REPOS</code>. Token forwarding stays off unless you explicitly set{" "}
        <code>REES_FORWARD_GITHUB_TOKEN=true</code>.
      </p>
      <CodeBlock
        filename=".env"
        code={`# Full REES off switch:
GITTENSORY_REVIEW_ENRICHMENT=false

# Keep REES on and explicitly allow token-aware analyzers:
REES_FORWARD_GITHUB_TOKEN=true`}
      />

      <h2>Analyzer selection</h2>
      <p>
        Leave <code>REES_ANALYZERS</code> unset, <code>all</code>, or <code>*</code> to use the
        selected <code>REES_PROFILE</code> defaults. To run a subset, use exact comma-separated
        analyzer names. Unknown names are ignored with a <code>rees_analyzer_config_invalid</code>{" "}
        warning and the remaining valid analyzers still run. If every configured name is invalid,
        the engine sends an empty analyzer list so the typo fails closed instead of running the full
        registry.
      </p>
      <CodeBlock
        filename=".env"
        code={`REES_PROFILE=fast
REES_ANALYZERS=secret,actionPin,redos`}
      />
      <CodeBlock filename="current analyzer names" code={REES_ANALYZER_NAMES.join("\n")} />
      <p>
        See the <Link to="/docs/self-hosting-rees-analyzers">REES analyzer reference</Link> for each
        analyzer's inputs, network behavior, and finding shape.
      </p>

      <h2>Request boundary</h2>
      <p>
        When enabled, the engine POSTs the repo name, PR number, head SHA, base SHA when GitHub
        supplies it, title, changed file paths, changed file patches, and review diff to{" "}
        <code>REES_URL</code>. It forwards no GitHub token by default. If{" "}
        <code>REES_FORWARD_GITHUB_TOKEN=true</code>, the engine includes a GitHub read token so
        GitHub API analyzers can read private CODEOWNERS and blob sizes. The engine prefers a
        short-lived installation token and falls back to <code>GITHUB_PUBLIC_TOKEN</code>. Enable
        forwarding only when the REES service is inside your trust boundary.
      </p>
      <Callout variant="safety">
        Do not point <code>REES_URL</code> at a service you do not trust with PR diffs. Token
        forwarding is optional, but the diff/files themselves can contain private code.
      </Callout>

      <h2>Service configuration</h2>
      <p>
        The REES service must use the matching <code>REES_SHARED_SECRET</code>. Optional Sentry env
        captures analyzer degradations without logging request bodies, tokens, diffs, or review
        content.
      </p>
      <CodeBlock
        filename="REES service env"
        code={`REES_SHARED_SECRET=<shared-secret>
SENTRY_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0`}
      />

      <h2>Failure behavior</h2>
      <FeatureRow
        items={[
          {
            title: "Transport failure",
            description:
              "The engine logs review_context_fetch_failed with contextType=enrichment and continues without REES context.",
          },
          {
            title: "Analyzer failure",
            description:
              "REES marks that analyzer degraded, may set partial=true, and returns findings from the analyzers that completed.",
          },
          {
            title: "Empty brief",
            description:
              "No prompt section is spliced into the AI review. The review proceeds with diff, grounding, and RAG context only.",
          },
          {
            title: "Auth rejection",
            description:
              "401/403 responses log authRejected=true, authConfigured, authHeaderSent, and whether the secret was normalized before sending.",
          },
        ]}
      />

      <h2>Security boundary</h2>
      <Callout variant="safety">
        REES output is untrusted advisory context. The engine sanitizes the public brief and never
        accepts REES-provided system instructions.
      </Callout>
      <p>
        For broader secret handling, see{" "}
        <Link to="/docs/self-hosting-security">Self-host security</Link>.
      </p>
    </DocsPage>
  );
}
