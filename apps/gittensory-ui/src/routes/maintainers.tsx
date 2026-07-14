import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  MessageSquare,
  ShieldCheck,
  Tag,
  Wrench,
  EyeOff,
  FileSearch,
} from "lucide-react";

import {
  Section,
  SectionTitle,
  Card,
  CodeBlock,
  Callout,
  FeatureRow,
} from "@/components/site/primitives";

export const Route = createFileRoute("/maintainers")({
  head: () => ({
    meta: [
      { title: "Maintainers — LoopOver" },
      {
        name: "description",
        content:
          "A quiet GitHub App for repo maintainers: confirmed-miner context, reviewability packets, install diagnostics, repo settings preview. No noisy public checks.",
      },
      { property: "og:title", content: "Maintainers — LoopOver" },
      {
        property: "og:description",
        content:
          "Confirmed-miner context, sanitized comments, label policy, and maintainer-only intelligence. Quiet by default.",
      },
      { property: "og:url", content: "/maintainers" },
    ],
    links: [{ rel: "canonical", href: "/maintainers" }],
  }),
  component: MaintainersPage,
});

function MaintainersPage() {
  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <div className="text-token-xs text-muted-foreground">For maintainers</div>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Quiet by default. Loud only when you ask.
          </h1>
          <p className="mt-4 text-token-lg text-muted-foreground">
            Self-host LoopOver on a repo and your review surface stays calm. No always-on check
            runs. No public scoring. You opt into confirmed-miner context, packets, and diagnostics
            with explicit commands.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              to="/docs/maintainer-self-hosting"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Self-host reviews <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/docs/maintainer-workflow"
              className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm hover:border-foreground/30"
            >
              Maintainer workflow
            </Link>
          </div>
        </div>
      </Section>

      <Section className="py-12">
        <FeatureRow
          items={[
            {
              icon: <EyeOff className="size-4" />,
              title: "No noisy checks",
              description:
                "No always-on public check runs. Public surface stays whatever it was before installing.",
            },
            {
              icon: <Tag className="size-4" />,
              title: "Confirmed-miner label",
              description:
                "Optional configured label on PRs from official confirmed Gittensor miners.",
            },
            {
              icon: <MessageSquare className="size-4" />,
              title: "Sanitized sticky comment",
              description:
                "At most one sticky comment per confirmed-miner PR. Never exposes private scoring or reward.",
            },
            {
              icon: <Wrench className="size-4" />,
              title: "@loopover commands",
              description:
                "Trigger preflight, blockers, duplicate-check, miner-context, next-action on demand from a PR comment.",
            },
            {
              icon: <FileSearch className="size-4" />,
              title: "Reviewability packet",
              description:
                "Maintainer-only packet summarizing readiness, risk, and review checkpoints for a PR.",
            },
            {
              icon: <ShieldCheck className="size-4" />,
              title: "Settings preview",
              description:
                "Preview Gittensor config recommendations and label policy before applying anything.",
            },
          ]}
        />
      </Section>

      <Section className="py-16">
        <SectionTitle
          eyebrow="Commands"
          title="Trigger context only when you want it."
          description="All commands are maintainer-invoked. Output stays scoped to maintainer-visible packets when appropriate."
        />
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {[
            ["@loopover help", "List available commands and their scopes."],
            ["@loopover preflight", "Run a metadata-only preflight on this PR."],
            ["@loopover blockers", "Why this PR isn't yet scoreable / mergeable cleanly."],
            ["@loopover duplicate-check", "Scan for related open work in the repo."],
            [
              "@loopover miner-context",
              "Confirmed-miner lane and outcome context (private to maintainers).",
            ],
            ["@loopover next-action", "Suggested next move for the contributor."],
          ].map(([cmd, desc]) => (
            <Card key={cmd}>
              <div className="font-mono text-token-sm text-mint">{cmd}</div>
              <p className="mt-2 text-token-sm text-muted-foreground">{desc}</p>
            </Card>
          ))}
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="font-display text-token-lg font-semibold">Repo settings preview</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Generate a recommended Gittensor config and label policy as a dry-run before applying
              anything to the repo.
            </p>
            <div className="mt-4">
              <CodeBlock
                lang="http"
                code={`GET  /v1/repos/:owner/:repo/gittensor-config-recommendation
GET  /v1/repos/:owner/:repo/settings
POST /v1/repos/:owner/:repo/settings-preview`}
              />
            </div>
          </Card>
          <Card>
            <h3 className="font-display text-token-lg font-semibold">Reviewability + readiness</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Maintainer-only packets that surface review checkpoints, risk, and intake health.
            </p>
            <div className="mt-4">
              <CodeBlock
                lang="http"
                code={`GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet
GET /v1/repos/:owner/:repo/pulls/:number/reviewability
GET /v1/repos/:owner/:repo/registration-readiness`}
              />
            </div>
          </Card>
        </div>

        <div className="mt-8">
          <Callout variant="safety" title="Public output is sanitized">
            Confirmed-miner PRs get at most one sticky comment and one configured label. No scoring
            numbers, no risk language, no reward implications appear publicly — ever.
          </Callout>
        </div>
      </Section>

      <Section className="py-16">
        <SectionTitle
          eyebrow="How it fits your repo"
          title="Quiet by default. Useful when called."
          description="A small set of moments where LoopOver pays for itself without adding review noise."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            {
              step: "On install",
              title: "Nothing changes publicly",
              body: "No auto-checks, no banner comments. Review surfaces stay exactly as they were.",
            },
            {
              step: "On PR open",
              title: "Confirmed-miner context",
              body: "Optional sanitized sticky comment and label — only on PRs from confirmed Gittensor miners.",
            },
            {
              step: "On demand",
              title: "Maintainer-only packets",
              body: "Trigger blockers, duplicate-check, or reviewability from a PR comment. Reasoning stays private.",
            },
          ].map((s, i) => (
            <Card key={s.step}>
              <div className="text-token-xs text-muted-foreground">
                Moment {i + 1} · {s.step}
              </div>
              <h3 className="mt-2 font-display text-token-base font-semibold">{s.title}</h3>
              <p className="mt-1 text-token-sm text-muted-foreground">{s.body}</p>
            </Card>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start gap-3 rounded-token border border-mint/30 bg-mint/[0.04] p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-display text-token-xl font-semibold">
              Preview the maintainer surface
            </h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              See exactly what posts publicly vs. what only you see privately — side by side.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/app/maintainer"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Open the preview <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/docs/maintainer-self-hosting"
              className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm hover:border-foreground/30"
            >
              Self-host reviews
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
