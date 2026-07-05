import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-ai-providers")({
  head: () => ({
    meta: [
      { title: "Self-host AI providers — Gittensory docs" },
      {
        name: "description",
        content:
          "Configure AI providers for self-hosted Gittensory reviews, including Anthropic, OpenAI-compatible endpoints, Ollama, Claude Code, and Codex.",
      },
      { property: "og:title", content: "Self-host AI providers — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Configure AI providers for self-hosted Gittensory reviews, including Anthropic, OpenAI-compatible endpoints, Ollama, Claude Code, and Codex.",
      },
      { property: "og:url", content: "/docs/self-hosting-ai-providers" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-ai-providers" }],
  }),
  component: SelfHostingAiProviders,
});

function SelfHostingAiProviders() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="AI providers"
      description="AI review is optional. The deterministic gate still runs when no provider is configured."
    >
      <h2>Provider options</h2>
      <FeatureRow
        items={[
          {
            title: "anthropic",
            description: "Native Anthropic Messages API. Requires ANTHROPIC_API_KEY.",
          },
          {
            title: "openai or openai-compatible",
            description:
              "OpenAI chat completions shape. Works with OpenAI, gateway providers, vLLM, Ollama, and compatible endpoints.",
          },
          {
            title: "ollama",
            description:
              "Local model endpoint. Good for private experiments; quality depends on the pulled model.",
          },
          {
            title: "claude-code",
            description:
              "Subscription CLI path. Requires CLI availability and CLAUDE_CODE_OAUTH_TOKEN from an interactive setup.",
          },
          {
            title: "codex",
            description:
              "Subscription CLI path. Treat credentials carefully; do not mount prompt-readable auth into untrusted review sandboxes.",
          },
        ]}
      />

      <h2>Single provider</h2>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<provider-key>
ANTHROPIC_AI_MODEL=claude-sonnet-4-6`}
      />

      <h2>OpenAI-compatible endpoint</h2>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_AI_BASE_URL=http://ollama:11434/v1
OPENAI_COMPATIBLE_AI_API_KEY=
OPENAI_COMPATIBLE_AI_MODEL=llama3.1`}
      />

      <h2>Fallback and dual review</h2>
      <p>
        A comma-list is a fallback chain by default. Use this for subscription CLIs when you want
        Codex first and Claude Code only when Codex is unavailable or out of tokens.
      </p>
      <CodeBlock
        filename=".env — fallback chain"
        code={`AI_PROVIDER=codex,claude-code
CODEX_AI_EFFORT=medium
CLAUDE_AI_EFFORT=medium
CLAUDE_CODE_OAUTH_TOKEN=
GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1`}
      />
      <p>
        Set <code>AI_DUAL_REVIEW=1</code> only when you want the first two providers to run as
        independent reviewers on every PR. In dual-review mode, <code>AI_COMBINE</code> controls how
        decisions are combined.
      </p>
      <CodeBlock
        filename=".env — dual review"
        code={`AI_PROVIDER=anthropic,ollama
AI_DUAL_REVIEW=1
AI_COMBINE=synthesis
AI_ON_MERGE=either`}
      />
      <FeatureRow
        items={[
          {
            title: "single",
            description:
              "One reviewer verdict. This is the automatic mode for one provider or a fallback chain.",
          },
          {
            title: "consensus",
            description:
              "Block only when both reviewers flag a critical defect. A lone defect holds for human review.",
          },
          {
            title: "synthesis",
            description:
              "Both reviewers run, then one merged decision is produced. AI_ON_MERGE controls either or both.",
          },
        ]}
      />

      <h2>Subscription CLI safety</h2>
      <Callout variant="warn" title="Credential isolation matters">
        Subscription CLIs store credentials on disk. Do not mount a writable or prompt-readable CLI
        home into review execution unless you have isolated it from PR-controlled content. Use an
        API provider or local OpenAI-compatible endpoint when isolation is not clear.
      </Callout>

      <h2>Related context</h2>
      <p>
        AI providers produce the review. <Link to="/docs/self-hosting-rees">REES</Link> and{" "}
        <Link to="/docs/self-hosting-rag">RAG</Link> add context that the reviewer can use.
      </p>
    </DocsPage>
  );
}
