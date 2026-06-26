# RAG: codebase indexing for smarter reviews

RAG (retrieval-augmented generation) gives the AI reviewer **codebase awareness**: at review time it retrieves the
existing code most relevant to the PR's diff — callers, similar implementations, conventions — and feeds it into
the reviewer's prompt. This catches "this duplicates `x`", "this breaks caller `y`", "the convention here is `z`",
and kills false "undefined symbol" noise. It is the single biggest review-quality lever.

## How it fits together

```
Review:   PR diff ───────────────────────────► Claude Code / Codex  (frontier reviewer, advisory)
                                                      ▲
Retrieval: changed files ─► embed (ollama bge-m3) ─► qdrant ANN ─► relevant code ─┘
```

The frontier model stays the **only** reviewer. ollama + qdrant are a _background retrieval layer_ — ollama turns
code into vectors, qdrant finds the nearest ones. They never review; they make the reviewer's context better.

**Why a separate embedder?** Claude and Codex are chat models — they cannot produce embedding vectors (Anthropic
has no embeddings model at all). So RAG needs a dedicated embed provider. It is wired _separately_ from the review
chain (`AI_EMBED_*` → its own provider) so that a Claude/Codex outage never causes reviews to fall back to a weak
local model — embeddings go to ollama, reviews stay frontier-only.

## Setup

```bash
# .env
GITTENSORY_REVIEW_RAG=true
QDRANT_URL=http://qdrant:6333
AI_EMBED_BASE_URL=http://ollama:11434/v1
AI_EMBED_MODEL=bge-m3            # see "Choosing an embed model"
# AI_EMBED_PROVIDER=ollama       # optional metric label (default "ollama")
# AI_EMBED_API_KEY=...           # only if your embed endpoint needs a key
```

```bash
docker compose --profile qdrant --profile ollama up -d qdrant ollama
docker exec gittensory-ollama-1 ollama pull bge-m3      # ~1.2 GB, one-time
docker compose up -d --force-recreate gittensory
```

Boot logs should show `selfhost_embed_provider` and `selfhost_vectorize{backend:"qdrant"}`.

> No qdrant? The SQLite backend ships a built-in `sqlite-vec` vector store, used automatically when `QDRANT_URL`
> is unset. qdrant is recommended for production (ANN, scales to millions of vectors).

## Choosing an embed model

The vector index is **1024-dimensional**, so use a 1024-d model:

| Model                      | Context     | Notes                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------- |
| **`bge-m3`** (recommended) | 8192 tokens | Long context fits whole code chunks; multilingual; strong retrieval. |
| `mxbai-embed-large`        | 512 tokens  | Smaller download, but **truncates** code chunks > 512 tokens.        |

## Indexing your repos

Three ways to trigger it:

1. **On demand** (operator action — add/refresh a repo immediately):
   ```bash
   # all configured repos:
   curl -X POST localhost:8787/v1/internal/jobs/rag-index -H "authorization: Bearer $INTERNAL_JOB_TOKEN"
   # one repo:
   curl -X POST localhost:8787/v1/internal/jobs/rag-index -H "authorization: Bearer $INTERNAL_JOB_TOKEN" \
        -H "content-type: application/json" -d '{"repoFullName":"owner/repo"}'
   ```
2. **Automatic cron** — the 6-hourly fan-out indexes every repo in `GITTENSORY_REVIEW_REPOS` (and any registered
   repo) where RAG is active. No `is_registered` needed.
3. **Incremental, automatic** — every merged PR re-indexes just its changed files, so the index self-maintains.

### Index-only (no reviews) for a repo

To build a repo's knowledge base **without** turning on reviews for it, give it a private config with _only_
`features.rag: true` and leave it out of `GITTENSORY_REVIEW_REPOS`:

```yaml
# {repo}/.gittensory.yml  (container-private)
features:
  rag: true
settings:
  aiReviewMode: off
  agentDryRun: true
```

RAG indexes the repo; no review features run, nothing is posted.

## What gets indexed

`isIndexablePath` indexes **code**, skipping `node_modules`, build output, lockfiles, and large content/data
corpora (e.g. a registry repo's JSON data). A hard `MAX_CHUNKS_PER_REPO` cap (1500) bounds cost. Retrieval is
**namespaced per `(project, repo)`** — a review on repo A retrieves from A's index (you review A against A's
conventions). Cross-repo retrieval is a deliberate future enhancement.

## Verifying it works

```bash
# qdrant collection should be green with a growing point count:
docker exec gittensory-gittensory-1 node -e \
 'fetch("http://qdrant:6333/collections/gittensory").then(r=>r.json()).then(j=>console.log(j.result.points_count,j.result.status))'
```

Chunk count per repo:

```bash
docker exec gittensory-gittensory-1 node -e \
 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/gittensory.sqlite",{readOnly:true}).prepare("SELECT repo,count(*) c FROM repo_chunks GROUP BY repo").all())'
```

See [troubleshooting.md](./troubleshooting.md) for RAG failure modes.
