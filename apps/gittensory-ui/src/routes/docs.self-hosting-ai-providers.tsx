import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-ai-providers")({
  head: () => ({
    meta: [
      { title: "Self-host AI providers — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure AI providers for self-hosted LoopOver reviews, including Anthropic, OpenAI-compatible endpoints, Ollama, Claude Code, and Codex.",
      },
      { property: "og:title", content: "Self-host AI providers — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure AI providers for self-hosted LoopOver reviews, including Anthropic, OpenAI-compatible endpoints, Ollama, Claude Code, and Codex.",
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
      <p>
        <code>ANTHROPIC_AI_BASE_URL</code> defaults to <code>https://api.anthropic.com</code> — set
        it only to route through a gateway or proxy in front of the real Anthropic API.
      </p>

      <h2>OpenAI API</h2>
      <p>
        Distinct from OpenAI-compatible below: this is the native OpenAI API path (
        <code>AI_PROVIDER=openai</code>), for when you have an OpenAI account key rather than a
        gateway or local endpoint.
      </p>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=openai
OPENAI_API_KEY=<provider-key>
OPENAI_AI_BASE_URL=https://api.openai.com/v1
OPENAI_AI_MODEL=gpt-5.5`}
      />
      <p>
        <code>OPENAI_AI_BASE_URL</code> and <code>OPENAI_AI_MODEL</code> already default to the
        values shown — set them only to override the endpoint or model.
      </p>

      <h2>OpenAI-compatible endpoint</h2>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_AI_BASE_URL=http://ollama:11434/v1
OPENAI_COMPATIBLE_AI_API_KEY=
OPENAI_COMPATIBLE_AI_MODEL=llama3.1`}
      />

      <h2>Ollama (dedicated provider)</h2>
      <p>
        <code>AI_PROVIDER=ollama</code> is a separate provider id from routing Ollama through{" "}
        <code>openai-compatible</code> above — use whichever matches how you want
        fallback/dual-review chains to identify it. Defaults to a local Ollama at{" "}
        <code>http://localhost:11434/v1</code> with no API key.
      </p>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=ollama
OLLAMA_AI_BASE_URL=http://ollama:11434/v1
OLLAMA_AI_API_KEY=
OLLAMA_AI_MODEL=llama3.1`}
      />
      <p>
        Set <code>OLLAMA_AI_BASE_URL</code> to <code>http://ollama:11434/v1</code> when using the
        compose <code>ollama</code> profile; <code>OLLAMA_AI_API_KEY</code> is normally left blank
        for a local, unauthenticated Ollama instance.
      </p>

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

      <h2>Claude Code (subscription)</h2>
      <p>
        No API key — <code>claude-code</code> runs your existing Claude subscription through the{" "}
        <code>claude</code> CLI. Generate a long-lived token once with{" "}
        <code>claude setup-token</code> and store it as <code>CLAUDE_CODE_OAUTH_TOKEN</code>.
      </p>
      <CodeBlock
        filename=".env"
        code={`AI_PROVIDER=claude-code
CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
CLAUDE_AI_EFFORT=medium`}
      />
      <p>
        <strong>Rotating it:</strong> when the subscription's usage limit resets or the token needs
        replacing, run <code>claude setup-token</code> again and paste the new value into{" "}
        <code>.env</code>. <code>CLAUDE_CODE_OAUTH_TOKEN</code> is baked into the container at
        creation time, so a plain restart keeps serving the old value — recreate the service
        instead:
      </p>
      <CodeBlock code={`docker compose up -d --no-deps loopover`} />
      <p>
        Prefer not pasting the raw token into <code>.env</code>? Write it into{" "}
        <code>secrets/claude_code_oauth_token.txt</code> instead (see{" "}
        <Link to="/docs/self-hosting-security">Security</Link>'s secret-file section) and leave{" "}
        <code>CLAUDE_CODE_OAUTH_TOKEN</code> unset in <code>.env</code> — the same recreate step
        above picks it up either way.
      </p>

      <h2>Codex (subscription)</h2>
      <p>
        Codex has no equivalent of <code>claude setup-token</code>. Instead of an environment
        variable, it stores an OAuth credential file, <code>auth.json</code>. Authenticate against
        the running container so the file lands on the volume the image expects (
        <code>/data/codex</code>, mounted at <code>~/.codex</code>):
      </p>
      <CodeBlock code={`docker compose exec gittensory codex auth`} />
      <p>
        This also needs the explicit opt-in shown in the fallback example above (
        <code>GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1</code>) — see the Subscription CLI safety
        note below for why it defaults to off.
      </p>
      <Callout variant="note" title="Rotating it needs no restart">
        Codex reads <code>auth.json</code> fresh on every review — each review spawns a new{" "}
        <code>codex</code> subprocess. Once <code>codex auth</code> succeeds, the very next review
        authenticates correctly; there is no service to recreate and no env var to change.
      </Callout>

      <h2>Recognizing a stale or missing credential</h2>
      <p>
        Both subscription CLIs fail loudly in the self-host logs instead of silently degrading the
        review:
      </p>
      <FeatureRow
        items={[
          {
            title: "claude_code_no_oauth_token",
            description:
              "CLAUDE_CODE_OAUTH_TOKEN is unset and no secrets/claude_code_oauth_token.txt file is populated. Set either and recreate the service.",
          },
          {
            title: "claude_code_error_401",
            description: "The token was rejected. Generate a fresh one with claude setup-token.",
          },
          {
            title: "codex_no_auth",
            description: "auth.json is missing or expired. Re-run codex auth.",
          },
          {
            title: "codex_credential_isolation_required",
            description:
              "GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER is not set to 1, or CODEX_HOME was set on the app container. Remove CODEX_HOME so Codex reads the mounted volume's default path.",
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
