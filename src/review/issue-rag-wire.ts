// Issue-centric RAG query composition (#2320). The miner analyze phase has no PR diff yet, so it feeds retrieval
// from the issue's title/body/labels while reusing the existing RAG engine unchanged.

import { MIN_QUERY_CHARS } from "./rag";

const MAX_ISSUE_BODY_CHARS = 4000;
const MAX_ISSUE_LABELS = 20;

export type IssueRagQueryInput = {
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
};

function cleanLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return labels
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, MAX_ISSUE_LABELS);
}

export function buildIssueRagQuery(input: IssueRagQueryInput): { queryText: string } {
  const sections: string[] = [];
  const title = input.title.trim();
  if (title) sections.push(title);

  const body = (input.body ?? "").trim().slice(0, MAX_ISSUE_BODY_CHARS);
  if (body) sections.push(body);

  const labels = cleanLabels(input.labels);
  if (labels.length > 0) sections.push(`Labels: ${labels.join(", ")}`);

  const queryText = sections.join("\n\n").trim();
  if (queryText.length < MIN_QUERY_CHARS) return { queryText: "" };
  return { queryText };
}
