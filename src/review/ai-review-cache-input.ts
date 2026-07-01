import { sha256Hex } from "../utils/crypto";
import type {
  ReviewPathInstruction,
  ReviewProfile,
} from "../signals/focus-manifest";
import type { RepositorySettings } from "../types";

type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

function stableJsonValue(value: unknown): StableJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return value;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)]),
    );
  }
  return null;
}

export async function aiReviewInputFingerprint(input: unknown): Promise<string> {
  return `ai-review-input:v1:${await sha256Hex(JSON.stringify(stableJsonValue(input)))}`;
}

export async function aiReviewCacheInputFingerprint(args: {
  changedPaths: string[];
  env: Partial<
    Pick<
      Env,
      | "GITTENSORY_REVIEW_ENRICHMENT"
      | "GITTENSORY_REVIEW_GROUNDING"
      | "GITTENSORY_REVIEW_INLINE_COMMENTS"
      | "GITTENSORY_REVIEW_RAG"
      | "GITTENSORY_REVIEW_REPUTATION"
      | "GITTENSORY_REVIEW_REPOS"
      | "REES_ANALYZERS"
      | "REES_FORWARD_GITHUB_TOKEN"
      | "REES_PROFILE"
      | "REES_TIMEOUT_MS"
      | "REES_URL"
    >
  >;
  mode: string;
  pr: { baseSha?: string | null | undefined; title: string };
  review: {
    effectiveInlineComments: boolean;
    excludePaths: string[];
    inlineComments: boolean;
    instructions: string | null;
    pathInstructions: ReviewPathInstruction[];
    profile: ReviewProfile | null;
  };
  settings: Pick<
    RepositorySettings,
    | "aiReviewAllAuthors"
    | "aiReviewByok"
    | "aiReviewCloseConfidence"
    | "aiReviewModel"
    | "aiReviewProvider"
    | "gatePack"
  >;
}): Promise<string> {
  return aiReviewInputFingerprint({
    changedPaths: args.changedPaths,
    env: {
      enrichment: args.env.GITTENSORY_REVIEW_ENRICHMENT ?? null,
      grounding: args.env.GITTENSORY_REVIEW_GROUNDING ?? null,
      inlineComments: args.env.GITTENSORY_REVIEW_INLINE_COMMENTS ?? null,
      rag: args.env.GITTENSORY_REVIEW_RAG ?? null,
      reesAnalyzers: args.env.REES_ANALYZERS ?? null,
      reesGithubTokenForwarding: args.env.REES_FORWARD_GITHUB_TOKEN ?? null,
      reesProfile: args.env.REES_PROFILE ?? null,
      reesTimeoutMs: args.env.REES_TIMEOUT_MS ?? null,
      reesUrlConfigured: Boolean(args.env.REES_URL),
      reputation: args.env.GITTENSORY_REVIEW_REPUTATION ?? null,
      reviewRepos: args.env.GITTENSORY_REVIEW_REPOS ?? null,
    },
    mode: args.mode,
    pr: {
      baseSha: args.pr.baseSha ?? null,
      title: args.pr.title,
    },
    review: args.review,
    settings: {
      aiReviewAllAuthors: args.settings.aiReviewAllAuthors,
      aiReviewByok: args.settings.aiReviewByok,
      aiReviewCloseConfidence: args.settings.aiReviewCloseConfidence ?? null,
      aiReviewModel: args.settings.aiReviewModel ?? null,
      aiReviewProvider: args.settings.aiReviewProvider ?? null,
      gatePack: args.settings.gatePack,
    },
  });
}
