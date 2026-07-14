import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Compass,
  GitPullRequest,
  ListChecks,
  Package,
  ShieldCheck,
} from "lucide-react";

import {
  Section,
  SectionTitle,
  Card,
  CodeBlock,
  Callout,
  FeatureRow,
} from "@/components/site/primitives";

export const Route = createFileRoute("/miners")({
  head: () => ({
    meta: [
      { title: "Miners — LoopOver" },
      {
        name: "description",
        content:
          "Plan repo-specific next actions, preflight branches with metadata only, understand scoreability blockers, and prepare public-safe PR packets.",
      },
      { property: "og:title", content: "Miners — LoopOver" },
      {
        property: "og:description",
        content:
          "MCP and CLI workflow for Gittensor contributors. Lane fit, branch preflight, scoreability scenarios, ranked next actions.",
      },
      { property: "og:url", content: "/miners" },
    ],
    links: [{ rel: "canonical", href: "/miners" }],
  }),
  component: MinersPage,
});

function MinersPage() {
  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <div className="text-token-xs text-muted-foreground">For miners</div>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Pick better work. Preflight branches. Ship cleanly.
          </h1>
          <p className="mt-4 text-token-lg text-muted-foreground">
            LoopOver's MCP and CLI give you private, deterministic context for every contribution:
            lane fit, blockers, scoreability scenarios, and the next actions most likely to clear
            the gate.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              to="/docs/quickstart"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Install MCP <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/docs/miner-workflow"
              className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm hover:border-foreground/30"
            >
              Read the workflow
            </Link>
          </div>
        </div>
      </Section>

      <Section className="py-12">
        <FeatureRow
          items={[
            {
              icon: <Compass className="size-4" />,
              title: "Plan next work",
              description:
                "Lane-aware repo targets to pursue or avoid, with risk-adjusted priority.",
            },
            {
              icon: <GitPullRequest className="size-4" />,
              title: "Preflight branches",
              description:
                "Metadata-only analysis of your current branch — labels, refs, linked issues, commits.",
            },
            {
              icon: <ListChecks className="size-4" />,
              title: "Explain blockers",
              description:
                "Cleanup-first guidance: queue pressure, missing issue links, unsquashed commits, validation gaps.",
            },
            {
              icon: <Package className="size-4" />,
              title: "Prepare PR packets",
              description:
                "Compose public-safe PR descriptions that read well to maintainers without leaking private signals.",
            },
            {
              icon: <ShieldCheck className="size-4" />,
              title: "Zero PAT",
              description:
                "Sign in via GitHub Device Flow. Session tokens are LoopOver-issued, not your personal access tokens.",
            },
            {
              icon: <Compass className="size-4" />,
              title: "Drift-aware",
              description:
                "When upstream Gittensor scoring shifts, your CLI warns you before you act on stale assumptions.",
            },
          ]}
        />
      </Section>

      <Section className="py-16">
        <SectionTitle eyebrow="Four commands" title="A miner's loop, end to end." />
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <Card>
            <div className="text-token-xs text-muted-foreground">1 · Sign in</div>
            <h3 className="mt-2 font-display text-token-lg font-semibold">GitHub Device Flow</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Authorize the CLI without ever pasting a PAT. The session token is a LoopOver token
              backed by your GitHub identity.
            </p>
            <div className="mt-4">
              <CodeBlock code={`gittensory-mcp login\ngittensory-mcp whoami`} />
            </div>
          </Card>
          <Card>
            <div className="text-token-xs text-muted-foreground">2 · Plan</div>
            <h3 className="mt-2 font-display text-token-lg font-semibold">Get a decision pack</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Lane fit, repo targets, freshness, and the ranked next actions that move you forward.
            </p>
            <div className="mt-4">
              <CodeBlock code={`gittensory-mcp agent plan --login your-login --json`} />
            </div>
          </Card>
          <Card>
            <div className="text-token-xs text-muted-foreground">3 · Preflight</div>
            <h3 className="mt-2 font-display text-token-lg font-semibold">Analyze the branch</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Metadata-only branch analysis returns lane context, scoreability scenarios, branch +
              account blockers, and maintainer-fit notes.
            </p>
            <div className="mt-4">
              <CodeBlock
                code={`gittensory-mcp analyze-branch --login your-login --json\ngittensory-mcp preflight --login your-login --json`}
              />
            </div>
          </Card>
          <Card>
            <div className="text-token-xs text-muted-foreground">4 · Packet</div>
            <h3 className="mt-2 font-display text-token-lg font-semibold">Compose the PR packet</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Public-safe PR description and ranked actions to take before opening or pushing.
              Private signals stay local.
            </p>
            <div className="mt-4">
              <CodeBlock code={`gittensory-mcp agent packet --json`} />
            </div>
          </Card>
        </div>
        <div className="mt-8">
          <Callout variant="safety">
            <strong>No source upload.</strong> The MCP sends metadata only: refs, changed-file
            metadata, labels, linked issues, commit messages, validation summaries, optional local
            scorer output.
          </Callout>
        </div>
      </Section>

      <Section className="py-16">
        <SectionTitle
          eyebrow="How it fits your day"
          title="A calm contributor loop."
          description="Three small moments where LoopOver removes guesswork without getting in your way."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            {
              step: "Morning",
              title: "Pick what to work on",
              body: "Open the CLI; pull a fresh decision pack. Lane fit and ranked next actions are ready before your coffee.",
            },
            {
              step: "Mid-flow",
              title: "Preflight the branch",
              body: "One command analyzes your branch metadata and tells you what would block scoreability before you push.",
            },
            {
              step: "Before opening a PR",
              title: "Compose a public-safe packet",
              body: "A ready-to-paste PR description with linked issues and labels — no private signals leak into GitHub.",
            },
          ].map((s, i) => (
            <Card key={s.step}>
              <div className="text-token-xs text-muted-foreground">
                Step {i + 1} · {s.step}
              </div>
              <h3 className="mt-2 font-display text-token-base font-semibold">{s.title}</h3>
              <p className="mt-1 text-token-sm text-muted-foreground">{s.body}</p>
            </Card>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start gap-3 rounded-token border border-mint/30 bg-mint/[0.04] p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-display text-token-xl font-semibold">Install the MCP and try it</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Two commands, no PAT, no source upload. You can also explore the agent playground
              first.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/docs/quickstart"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Install <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/app/playground"
              className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm hover:border-foreground/30"
            >
              Open playground
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
