import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/ai-summaries")({
  head: () => ({
    meta: [
      { title: "AI summaries — Gittensory docs" },
      {
        name: "description",
        content:
          "How Gittensory uses AI: only over deterministic signals, never as a source of truth, with strict public/private boundaries.",
      },
      { property: "og:title", content: "AI summaries — Gittensory docs" },
      {
        property: "og:description",
        content:
          "How Gittensory uses AI: only over deterministic signals, never as a source of truth, with strict public/private boundaries.",
      },
      { property: "og:url", content: "/docs/ai-summaries" },
    ],
    links: [{ rel: "canonical", href: "/docs/ai-summaries" }],
  }),
  component: AiSummariesDoc,
});

function AiSummariesDoc() {
  return (
    <DocsPage
      eyebrow="Roadmap · exploring"
      title="Optional AI summaries"
      description="A short natural-language summary over the deterministic response. Off by default. Never the source of truth."
    >
      <h2>The rule</h2>
      <p>
        Gittensory is deterministic. When AI summaries are enabled, they sit
        <em> on top of</em> the structured response — they never replace it, never add facts that
        aren&apos;t in the response, and never change ranked actions, blockers, or scoreability
        numbers.
      </p>

      <h2>Where they appear</h2>
      <ul>
        <li>
          In the <code>/app/playground</code> tool runs, behind an opt-in toggle, above the JSON.
        </li>
        <li>
          Optionally inside the MCP CLI with <code>--summary</code>, printed above the structured
          output.
        </li>
        <li>
          Never in public GitHub comments. Never in maintainer packets without explicit maintainer
          opt-in.
        </li>
      </ul>

      <h2>What is sent to the model</h2>
      <CodeBlock
        lang="json"
        code={`{
  "tool":   "plan-next-work",
  "response": { /* deterministic JSON shown to user */ },
  "context": {
    "boundary": "private-mcp",
    "ruleset_snapshot": "rs_2026_05_29_a1f3"
  }
}`}
      />
      <p>
        Only the response Gittensory already showed you, plus the boundary and ruleset snapshot, are
        sent. No source code, no PAT, no GitHub identity, no per-user history.
      </p>

      <h2>Model choice</h2>
      <p>
        You pick the provider per-session: GPT, Claude, or a local model. Defaults to off. The
        selection lives in your browser only and is cleared on sign-out.
      </p>

      <Callout variant="safety">
        <strong>Never the source of truth.</strong> If the summary disagrees with the structured
        response, trust the structured response. The summary is a convenience layer, never an
        authority.
      </Callout>
    </DocsPage>
  );
}
