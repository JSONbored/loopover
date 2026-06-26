// Review-enrichment service (REES) wiring (#1472). POSTs the PR to the external REES, which runs the heavy/
// external/historical analysis the no-checkout `claude --print` reviewer can't (dependency CVEs, leaked secrets,
// license/EOL/supply-chain), and returns a pre-rendered, public-safe brief the engine splices into the review
// prompt next to grounding + RAG (same { promptSection, systemSuffix } shape, same splice points in ai-review.ts).
//
// Single env switch: GITTENSORY_REVIEW_ENRICHMENT (+ REES_URL must be set, so the hosted Worker — which sets neither
// — is unaffected). Default OFF → gathers nothing, prompt byte-identical. FULLY FAIL-SAFE: any timeout / non-200 /
// network / parse error, or an empty brief, returns undefined and the review proceeds on diff + grounding + RAG.
import type { PullRequestFileRecord } from "../types";

interface EnrichmentEnv {
  GITTENSORY_REVIEW_ENRICHMENT?: string | undefined;
  REES_URL?: string | undefined;
  REES_SHARED_SECRET?: string | undefined;
  REES_TIMEOUT_MS?: string | undefined;
}

// The REES vars are self-host-only runtime env (process.env), not declared on the Worker Env type — read them via
// this cast. The hosted Worker simply has none set, so isEnrichmentEnabled is false there.
function reesConfig(env: Env): EnrichmentEnv {
  return env as unknown as EnrichmentEnv;
}

/** True when enrichment is enabled: the flag is on AND the REES URL is configured. OFF ⇒ no call, prompt unchanged. */
export function isEnrichmentEnabled(env: Env): boolean {
  const cfg = reesConfig(env);
  return (
    /^(1|true|yes|on)$/i.test(cfg.GITTENSORY_REVIEW_ENRICHMENT ?? "") &&
    Boolean(cfg.REES_URL?.trim())
  );
}

interface EnrichmentInput {
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  baseSha?: string | null;
  title?: string | undefined;
  files: PullRequestFileRecord[];
  diff: string;
}

/** POST the PR to the REES and return the spliceable brief, or undefined on any error/timeout/empty (fail-safe). */
export async function buildReviewEnrichment(
  env: Env,
  input: EnrichmentInput,
): Promise<{ promptSection: string; systemSuffix: string } | undefined> {
  const cfg = reesConfig(env);
  const base = cfg.REES_URL?.trim();
  if (!base) return undefined;
  const timeoutMs = Math.max(1000, Number(cfg.REES_TIMEOUT_MS ?? "8000"));
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/v1/enrich`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.REES_SHARED_SECRET
          ? { authorization: `Bearer ${cfg.REES_SHARED_SECRET}` }
          : {}),
      },
      body: JSON.stringify({
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha ?? null,
        title: input.title,
        files: input.files.map((file) => ({
          path: file.path,
          patch:
            typeof file.payload?.patch === "string"
              ? file.payload.patch
              : undefined,
        })),
        diff: input.diff,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const brief = (await response.json()) as {
      promptSection?: string;
      systemSuffix?: string;
    };
    const promptSection = brief.promptSection?.trim();
    if (!promptSection) return undefined; // no findings ⇒ no section ⇒ byte-identical prompt
    return { promptSection, systemSuffix: brief.systemSuffix ?? "" };
  } catch {
    return undefined; // timeout / network / parse ⇒ fail-safe; review proceeds without the brief
  }
}
