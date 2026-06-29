import type { AdvisoryFinding } from "../types";

export const REVIEW_THREAD_BLOCKER_CODE = "review_thread_unresolved";

const SCANNER_FINDING_MARKER = /<!--\s*(?:brin-pr-finding|superagent-finding-fingerprint:)/i;
const MARKDOWN_PRIORITY_TITLE = /\*\*\s*(P[0-3])\s*:\s*\*\*\s*([^\n\r]+)/i;
const XML_PRIORITY = /<priority>\s*(P[0-3])\s*<\/priority>/i;
const XML_TITLE = /<title>\s*([^<]+?)\s*<\/title>/i;

export type ReviewThreadCommentInput = {
  body?: string | null | undefined;
  authorLogin?: string | null | undefined;
  url?: string | null | undefined;
};

export type ReviewThreadBlocker = {
  title: string;
  priority?: "P0" | "P1" | "P2" | "P3" | undefined;
  path?: string | null | undefined;
  line?: number | null | undefined;
  authorLogin?: string | null | undefined;
  url?: string | null | undefined;
  scannerFinding: boolean;
};

export function buildReviewThreadBlocker(input: {
  path?: string | null | undefined;
  line?: number | null | undefined;
  comments: ReviewThreadCommentInput[];
}): ReviewThreadBlocker | null {
  const comments = input.comments.filter((comment) => (comment.body ?? "").trim().length > 0);
  if (comments.length === 0) return null;
  const scannerComment = comments.find((comment) => SCANNER_FINDING_MARKER.test(comment.body ?? ""));
  const comment = scannerComment ?? comments[0]!;
  const body = comment.body ?? "";
  const title = reviewThreadTitle(body);
  const priority = reviewThreadPriority(body);
  return {
    title,
    ...(priority ? { priority } : {}),
    path: input.path,
    line: input.line,
    authorLogin: comment.authorLogin,
    url: comment.url,
    scannerFinding: scannerComment !== undefined,
  };
}

export function reviewThreadBlockerFinding(blocker: ReviewThreadBlocker): AdvisoryFinding {
  const location = reviewThreadLocation(blocker);
  const actor = blocker.authorLogin ? `${blocker.authorLogin} ` : "";
  const priority = blocker.priority ? `${blocker.priority} ` : "";
  const title = `${actor}review thread unresolved: ${priority}${blocker.title}${location ? ` (${location})` : ""}`;
  return {
    code: REVIEW_THREAD_BLOCKER_CODE,
    severity: "critical",
    title,
    detail: `GitHub reports an unresolved review thread${location ? ` at ${location}` : ""}. The PR should not be approved or merged until the thread is resolved.`,
    action: "Resolve the review thread or push a fix, then re-run the gate.",
  };
}

function reviewThreadLocation(blocker: Pick<ReviewThreadBlocker, "path" | "line">): string {
  const path = blocker.path?.trim();
  if (!path) return "";
  return typeof blocker.line === "number" && Number.isFinite(blocker.line) && blocker.line > 0 ? `${path}:${blocker.line}` : path;
}

function reviewThreadPriority(body: string): ReviewThreadBlocker["priority"] | undefined {
  const markdown = MARKDOWN_PRIORITY_TITLE.exec(body)?.[1];
  const xml = XML_PRIORITY.exec(body)?.[1];
  const priority = (markdown ?? xml)?.toUpperCase();
  return priority === "P0" || priority === "P1" || priority === "P2" || priority === "P3" ? priority : undefined;
}

function reviewThreadTitle(body: string): string {
  const markdown = MARKDOWN_PRIORITY_TITLE.exec(body)?.[2];
  const xml = XML_TITLE.exec(body)?.[1];
  const direct = markdown ?? xml ?? firstMeaningfulLine(body) ?? "review thread";
  return cleanTitle(direct);
}

function firstMeaningfulLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("<!--") && !line.startsWith("<details") && !line.startsWith("<summary") && !line.startsWith("```"));
}

function cleanTitle(value: string): string {
  return value
    .replace(/<\/?[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
