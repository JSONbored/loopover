import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Server, Workflow, Wrench } from "lucide-react";

import { Section, SectionTitle, Card, CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/agents")({
  head: () => ({
    meta: [
      { title: "Coding agents — Gittensory" },
      {
        name: "description",
        content:
          "MCP server for Codex, Claude Desktop, Cursor. Deterministic tools for plan, preflight, branch analysis, and packet prep.",
      },
      { property: "og:title", content: "Coding agents — Gittensory" },
      {
        property: "og:description",
        content:
          "A deterministic MCP base layer for coding agents working in the Gittensor ecosystem.",
      },
      { property: "og:url", content: "/agents" },
    ],
    links: [{ rel: "canonical", href: "/agents" }],
  }),
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <div className="text-token-xs text-muted-foreground">Built for coding agents</div>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Deterministic tools, not vibes.
          </h1>
          <p className="mt-4 text-token-lg text-muted-foreground">
            Gittensory ships an MCP server that exposes structured, schema-validated tools for plan,
            preflight, branch analysis, and packet prep. Use it as the base layer for Codex, Claude
            Desktop, Cursor, or your own agent runtime.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              to="/docs/mcp-clients"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              MCP client setup <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/api"
              className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm hover:border-foreground/30"
            >
              API reference
            </Link>
          </div>
        </div>
      </Section>

      <Section className="py-12">
        <div className="grid gap-5 lg:grid-cols-3">
          <Card>
            <div className="mb-3 inline-flex size-9 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint">
              <Server className="size-4" />
            </div>
            <h3 className="font-display text-token-lg font-semibold">stdio + remote</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Run the MCP as a local stdio process, or connect to the remote MCP at the Worker.
            </p>
            <div className="mt-4">
              <CodeBlock code={`gittensory-mcp --stdio`} />
              <div className="mt-2">
                <CodeBlock code={`npx -y @jsonbored/gittensory-mcp@latest --stdio`} />
              </div>
              <div className="mt-2">
                <CodeBlock lang="http" code={`https://gittensory-api.aethereal.dev/mcp`} />
              </div>
            </div>
          </Card>
          <Card>
            <div className="mb-3 inline-flex size-9 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint">
              <Wrench className="size-4" />
            </div>
            <h3 className="font-display text-token-lg font-semibold">Structured tool schemas</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Every tool input/output is typed and validated. Agents get deterministic,
              machine-readable results.
            </p>
            <ul className="mt-4 space-y-1.5 font-mono text-[12px] text-foreground/80">
              <li>· plan_next_work</li>
              <li>· preflight_branch</li>
              <li>· analyze_branch</li>
              <li>· explain_blockers</li>
              <li>· prepare_pr_packet</li>
            </ul>
          </Card>
          <Card>
            <div className="mb-3 inline-flex size-9 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint">
              <Bot className="size-4" />
            </div>
            <h3 className="font-display text-token-lg font-semibold">Init helpers</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Print ready-to-paste config snippets for Codex, Claude Desktop, and Cursor.
            </p>
            <div className="mt-4">
              <CodeBlock
                code={`gittensory-mcp doctor
gittensory-mcp status
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor`}
              />
            </div>
          </Card>
        </div>
      </Section>

      <Section className="py-12">
        <SectionTitle
          eyebrow="Workflow"
          title="The agent loop, made boring on purpose."
          description="Predictable inputs, predictable outputs. The agent makes decisions; Gittensory makes those decisions explainable."
        />
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {[
            ["plan", "Decision pack → repo targets + ranked next actions."],
            ["preflight", "Metadata-only branch analysis with scenarios."],
            ["explain", "Concrete, human-readable blockers and cleanup steps."],
            ["packet", "Public-safe PR description ready to commit/push."],
          ].map(([t, d], i) => (
            <Card key={t}>
              <div className="text-token-xs text-muted-foreground">step {i + 1}</div>
              <div className="mt-2 flex items-center gap-2">
                <Workflow className="size-4 text-mint" />
                <span className="font-display text-token-lg font-semibold">{t}</span>
              </div>
              <p className="mt-1 text-token-sm text-muted-foreground">{d}</p>
            </Card>
          ))}
        </div>
        <div className="mt-8">
          <Callout variant="safety">
            Agents never need a GitHub PAT or repo source. Inputs are metadata; outputs are
            structured. The MCP enforces both.
          </Callout>
        </div>
      </Section>

      <Section className="py-16">
        <SectionTitle
          eyebrow="How it fits your agent"
          title="Drop-in tools, predictable shapes."
          description="Three places Gittensory makes your agent's contribution loop boring on purpose."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            {
              step: "Boot",
              title: "Print client config",
              body: "`init-client` writes the MCP config for Codex, Claude Desktop, or Cursor. No copy-paste required.",
            },
            {
              step: "Plan",
              title: "Deterministic ranked work",
              body: "`plan_next_work` returns repo targets and ranked actions over the deterministic decision pack.",
            },
            {
              step: "Ship",
              title: "Packet, not prose",
              body: "`prepare_pr_packet` returns a structured packet with labels and linked-issue lines ready to commit.",
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
            <h3 className="font-display text-token-xl font-semibold">Wire it into your client</h3>
            <p className="mt-1 text-token-sm text-muted-foreground">
              Set up MCP in your editor, then explore each tool in the live playground.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/docs/mcp-clients"
              className="inline-flex items-center gap-2 rounded-token bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Client setup <ArrowRight className="size-4" />
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
