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
              "GITTENSORY_REVIEW_RAG=true and the repo in GITTENSORY_REVIEW_REPOS, or a private per-repo feature toggle.",
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
