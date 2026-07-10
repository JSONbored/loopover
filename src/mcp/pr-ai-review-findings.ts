import { getLatestPublishedAiReview } from "../db/repositories";
import { classifyFindingCategory, FINDING_CATEGORIES, isFindingCategory, type FindingCategory } from "../review/finding-category-classify";
import type { InlineFinding } from "../services/ai-review";
import { resolveRepositorySettings } from "../settings/repository-settings";

/** Metadata key written by the review processor when caching a fresh AI review (#4519). */
export const INLINE_FINDINGS_METADATA_KEY = "inlineFindings" as const;

export type StructuredAiReviewFinding = {
  category: FindingCategory;
  path: string;
  severity: InlineFinding["severity"];
  line: number;
  body: string;
};

export type PrAiReviewFindingsPayload =
  | {
      status: "ready";
      repoFullName: string;
      pullNumber: number;
      login: string;
      headSha: string | null;
      findings: StructuredAiReviewFinding[];
      categoryCounts: Partial<Record<FindingCategory, number>>;
    }
  | {
      status: "not_found";
      repoFullName: string;
      pullNumber: number;
      login: string;
      findings: [];
      categoryCounts: Record<string, never>;
    }
  | {
      status: "ai_review_off";
      repoFullName: string;
      pullNumber: number;
      login: string;
      findings: [];
      categoryCounts: Record<string, never>;
    };

function isInlineFindingSeverity(value: unknown): value is InlineFinding["severity"] {
  return value === "blocker" || value === "nit";
}

/** Parse line-anchored findings persisted in `ai_review_cache.metadata_json.inlineFindings`. */
export function parseStoredInlineFindings(metadata: Record<string, unknown> | undefined): InlineFinding[] {
  const raw = metadata?.[INLINE_FINDINGS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const findings: InlineFinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.path !== "string" || candidate.path.length === 0) continue;
    if (typeof candidate.body !== "string") continue;
    if (!isInlineFindingSeverity(candidate.severity)) continue;
    const line = candidate.line;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) continue;
    findings.push({
      path: candidate.path,
      line,
      severity: candidate.severity,
      body: candidate.body,
      ...(isFindingCategory(candidate.category) ? { category: candidate.category } : {}),
    });
  }
  return findings;
}

/** Normalize inline findings to the structured MCP shape, applying the same category fallback as the PR comment. */
export function buildStructuredAiReviewFindings(inlineFindings: InlineFinding[]): StructuredAiReviewFinding[] {
  return inlineFindings.map((finding) => ({
    category: finding.category ?? classifyFindingCategory(finding),
    path: finding.path,
    severity: finding.severity,
    line: finding.line,
    body: finding.body,
  }));
}

/** Count findings per category using the same rules as `buildFindingCategoryCollapsible`. */
export function buildFindingCategoryCounts(findings: StructuredAiReviewFinding[]): Partial<Record<FindingCategory, number>> {
  const counts: Partial<Record<FindingCategory, number>> = {};
  for (const finding of findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  }
  return counts;
}

/** Ordered category count rows matching the human-facing collapsible table (security-first). */
export function orderedFindingCategoryCountRows(counts: Partial<Record<FindingCategory, number>>): Array<{ category: FindingCategory; count: number }> {
  return FINDING_CATEGORIES.flatMap((category) => {
    const count = counts[category];
    if (!count) return [];
    return [{ category, count }];
  });
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return typeof value === "string" && value.toLowerCase() === login.toLowerCase();
}

/** Load a submitted PR's published AI-review inline findings for MCP (#4519). */
export async function loadPrAiReviewFindings(
  env: Env,
  args: { repoFullName: string; pullNumber: number; login: string },
): Promise<PrAiReviewFindingsPayload> {
  const base = { repoFullName: args.repoFullName, pullNumber: args.pullNumber, login: args.login.toLowerCase() };
  const settings = await resolveRepositorySettings(env, args.repoFullName);
  if (settings.aiReviewMode === "off") {
    return { status: "ai_review_off", ...base, findings: [], categoryCounts: {} };
  }

  const published = await getLatestPublishedAiReview(env, args.repoFullName, args.pullNumber, settings.aiReviewMode);
  if (!published) {
    return { status: "not_found", ...base, findings: [], categoryCounts: {} };
  }

  const inlineFindings = parseStoredInlineFindings(published.metadata);
  const findings = buildStructuredAiReviewFindings(inlineFindings);
  return {
    status: "ready",
    ...base,
    headSha: published.headSha ?? null,
    findings,
    categoryCounts: buildFindingCategoryCounts(findings),
  };
}

export function assertContributorOwnsPullRequest(authorLogin: string | null | undefined, login: string): void {
  if (!sameLogin(authorLogin, login)) {
    throw new Error("Forbidden: this tool only returns AI-review findings for your own pull requests.");
  }
}
