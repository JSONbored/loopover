import type { BountyRecord, JsonValue } from "../types";

type GittIssueListPayload = {
  success?: boolean;
  issue_count?: number;
  issues?: Array<{
    id?: number | string;
    repository_full_name?: string;
    issue_number?: number;
    status?: string;
    bounty_alpha?: string;
    target_alpha?: string;
    bounty_amount?: number;
    target_bounty?: number;
  }>;
};

export function normalizeGittBountySnapshot(payload: unknown): BountyRecord[] {
  // `payload` is `unknown` and reaches here as `null` when the import route's `c.req.json()` rejects on an
  // empty/malformed body (`.catch(() => null)`). Optional-chain so a null/undefined payload degrades to an
  // empty list — matching how every other non-object value already yields `[]` — instead of throwing.
  const data = payload as GittIssueListPayload | null | undefined;
  return (data?.issues ?? []).flatMap((issue) => {
    if (issue.id === undefined || !issue.repository_full_name || !issue.issue_number || !issue.status) return [];
    const amountText = issue.bounty_alpha ?? (issue.bounty_amount === undefined ? undefined : String(issue.bounty_amount));
    return [
      {
        id: String(issue.id),
        repoFullName: issue.repository_full_name,
        issueNumber: issue.issue_number,
        status: issue.status,
        amountText,
        sourceUrl: `gitt://issues/${issue.id}`,
        payload: toJsonRecord(issue),
      },
    ];
  });
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      record[key] = item;
    }
  }
  return record;
}
