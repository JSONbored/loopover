import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-rag")({
  head: () => ({
    meta: [
      { title: "Self-host RAG indexing — Gittensory docs" },
      {
        name: "description",
        content:
          "Configure retrieval-augmented review context for self-hosted Gittensory with embeddings, Qdrant, indexing jobs, and cold-index behavior.",
      },
      { property: "og:title", content: "Self-host RAG indexing — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Configure retrieval-augmented review context for self-hosted Gittensory with embeddings, Qdrant, indexing jobs, and cold-index behavior.",
      },
      { property: "og:url", content: "/docs/self-hosting-rag" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rag" }],
  }),
  component: SelfHostingRag,
});

function SelfHostingRag() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="RAG indexing"
      description="RAG adds relevant existing code and docs to the AI reviewer prompt. It is additive and fail-safe."
    >
      <h2>Prerequisites</h2>
      <FeatureRow
        items={[
          {
            title: "Repo activation",
            description:
              "GITTENSORY_REVIEW_RAG=true, repo in GITTENSORY_REVIEW_REPOS (or features.rag: true in private config). Gittensor is_registered is not required for self-host RAG when the allowlist covers the repo.",
          },
          {
            title: "Vector backend",
            description:
              "SQLite vectors by default, Qdrant with the qdrant profile, or Postgres/pgvector where configured.",
          },
          {
            title: "Embedding provider",
            description:
              "An OpenAI-compatible embeddings endpoint with a model whose dimension matches the vector collection.",
          },
        ]}
      />

      <h2>Choosing a vector backend</h2>
      <p>
        SQLite vectors are the default and need no extra service — fine for a small instance or
        getting started. Qdrant (<code>QDRANT_URL</code>, <code>--profile qdrant</code>) is the
        preferred dedicated vector store for review context at scale. A third option,{" "}
        <code>PGVECTOR_ENABLED=true</code>, uses the Postgres pgvector table instead — only relevant
        if you're already running the <code>postgres</code> profile and want to avoid standing up a
        separate Qdrant service. Leave it <code>false</code> (the default) when{" "}
        <code>QDRANT_URL</code> is set; Qdrant remains preferred for RAG at scale.
      </p>

      <h2>Qdrant and Ollama example</h2>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_RAG=true
GITTENSORY_REVIEW_REPOS=owner/repo
QDRANT_URL=http://qdrant:6333
QDRANT_DIM=768
AI_EMBED_BASE_URL=http://ollama:11434/v1
AI_EMBED_MODEL=nomic-embed-text:latest`}
      />
      <CodeBlock
        lang="bash"
        code={`docker compose --profile qdrant --profile ollama up -d
docker compose exec ollama ollama pull nomic-embed-text:latest`}
      />
      <p>
        Use <code>QDRANT_DIM=1024</code> for 1024-dimensional models such as <code>bge-m3</code> or{" "}
        <code>mxbai-embed-large</code>. If a Qdrant collection already exists, recreate it before
        changing dimensions.
      </p>
      <p>
        <code>AI_EMBED_API_KEY</code> is the bearer credential for <code>AI_EMBED_BASE_URL</code>,
        if that endpoint requires one — a local Ollama typically doesn't, but a hosted
        OpenAI-compatible embeddings endpoint usually does. Setting <code>AI_EMBED_MODEL</code>{" "}
        alone does nothing without <code>AI_EMBED_BASE_URL</code> also set; unset, embeddings use
        the same provider as the rest of the review chain.
      </p>

      <h2>Indexing</h2>
      <p>
        RAG needs an index before it can retrieve useful context. A cold or missing index degrades
        to no context; the review still runs.
      </p>
      <CodeBlock
        lang="bash"
        code={`curl -X POST http://localhost:8787/v1/internal/jobs/rag-index \\
  -H "authorization: Bearer $INTERNAL_JOB_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"repoFullName":"owner/repo"}'`}
      />

      <h2>Operational checks</h2>
      <ul>
        <li>
          Boot logs should include <code>selfhost_embed_provider</code> when an embedding provider
          is configured.
        </li>
        <li>
          Qdrant mode should log <code>selfhost_vectorize</code> with backend <code>qdrant</code>.
        </li>
        <li>
          Empty RAG context usually means the repo is not indexed, the embed model is unavailable,
          or dimensions do not match.
        </li>
      </ul>

      <Callout variant="note">
        RAG is context, not authority. The AI reviewer still has to verify every claim against the
        diff, grounding, and review rules.
      </Callout>
      <p>
        Pair RAG with <Link to="/docs/self-hosting-ai-providers">AI providers</Link> and optionally{" "}
        <Link to="/docs/self-hosting-rees">REES</Link>.
      </p>
    </DocsPage>
  );
}
