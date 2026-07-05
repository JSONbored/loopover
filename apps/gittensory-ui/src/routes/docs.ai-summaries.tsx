import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout } from "@/components/site/primitives";

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
          In the <code>/app/playground</code> tool runs, behind an opt-in "Include AI summary"
          toggle, above the JSON.
        </li>
        <li>
          As an optional AI-clarified rewrite of the public PR intelligence comment, gated
          server-side by <code>AI_PUBLIC_COMMENTS_ENABLED</code> and always falling back to the
          deterministic comment body on any error, quota limit, or unsafe output.
        </li>
        <li>Never in maintainer packets without explicit maintainer opt-in.</li>
      </ul>
      <Callout variant="note">
        The playground's toggle currently renders a local, deterministic preview of the structured
        response — it does not call the backend AI summary service described below yet. Treat it as
        a stand-in for what a wired-up summary would look like.
      </Callout>

      <h2>What is sent to the model</h2>
      <p>
        A compacted signal bundle — the run's objective, actor login, surface, status, and data
        quality, plus up to five ranked actions (kind, recommendation, why, blockers) and up to
        eight freshness warnings. For a public rewrite, scoreability/risk fields are stripped before
        the bundle is built, not filtered out of the model's response after the fact.
      </p>
      <p>
        No source code, no PAT, no GitHub identity beyond the acting login, and no per-user history
        beyond the current run are sent.
      </p>

      <h2>Model choice</h2>
      <p>
        There is no per-user or per-session model picker. The operator configures one AI provider
        for the whole instance — see{" "}
        <Link to="/docs/self-hosting-ai-providers">self-hosting AI providers</Link> for the
        Codex/Claude Code/Ollama/OpenAI-compatible/Anthropic options. Summaries are off by default (
        <code>AI_SUMMARIES_ENABLED</code>); public-comment rewriting is a separate,
        also-off-by-default switch (<code>AI_PUBLIC_COMMENTS_ENABLED</code>).
      </p>

      <Callout variant="safety">
        <strong>Never the source of truth.</strong> If the summary disagrees with the structured
        response, trust the structured response. The summary is a convenience layer, never an
        authority.
      </Callout>
    </DocsPage>
  );
}
