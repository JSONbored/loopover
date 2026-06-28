// Revert-recurrence analyzer (#1696). Flags PRs that revert prior work or re-introduce churn patterns
// associated with regression risk — explicit revert titles, rollback language, and symmetric file churn
// where a change mostly deletes what a prior PR added (or vice versa). Pure text/diff analysis, no network.
import type { EnrichRequest, RevertRecurrenceFinding } from "../types.js";

const MAX_FINDINGS = 15;
const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 4000;

const EXPLICIT_REVERT_TITLE = /^revert[\s:]/i;
const EXPLICIT_REVERT_BODY =
  /\b(reverts commit|this reverts|reverted in|revert of)\b/i;
const ROLLBACK_LANGUAGE =
  /\b(rollback|roll back|rolled back|undo(?:ing)?|revert(?:ing|ed)?)\b/i;

interface FileChurn {
  path: string;
  additions: number;
  deletions: number;
}

/** Count `+`/`-` hunk lines per file from unified diff patches (bounded). */
export function summarizeFileChurn(
  files: NonNullable<EnrichRequest["files"]>,
): FileChurn[] {
  const churn: FileChurn[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of file.patch.split("\n", 2000)) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@"))
        continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    if (additions + deletions > 0) {
      churn.push({ path: file.path, additions, deletions });
    }
  }
  return churn;
}

/** True when one side dominates — classic revert/re-apply shape (large deletions + few additions or vice versa). */
export function isSymmetricChurn(entry: FileChurn): boolean {
  const total = entry.additions + entry.deletions;
  if (total < 12) return false;
  const dominant = Math.max(entry.additions, entry.deletions);
  const minor = Math.min(entry.additions, entry.deletions);
  if (dominant < 8) return false;
  if (minor === 0) return true;
  return dominant / minor >= 4;
}

/** Scan title/body for explicit revert or rollback language. */
export function detectRevertLanguage(
  title: string | undefined,
  body: string | undefined,
): RevertRecurrenceFinding[] {
  const findings: RevertRecurrenceFinding[] = [];
  const safeTitle = (title ?? "").slice(0, MAX_TITLE_CHARS);
  const safeBody = (body ?? "").slice(0, MAX_BODY_CHARS);

  if (EXPLICIT_REVERT_TITLE.test(safeTitle.trim())) {
    findings.push({
      kind: "explicit-revert",
      detail: `PR title signals an explicit revert: ${safeTitle.trim().slice(0, 120)}`,
      confidence: "high",
    });
  } else if (EXPLICIT_REVERT_BODY.test(safeBody)) {
    findings.push({
      kind: "explicit-revert",
      detail: "PR body references reverting a prior commit or change set",
      confidence: "high",
    });
  }

  if (
    ROLLBACK_LANGUAGE.test(safeTitle) ||
    ROLLBACK_LANGUAGE.test(safeBody)
  ) {
    findings.push({
      kind: "rollback-language",
      detail:
        "PR title or body uses rollback/undo language — verify this is intentional and covered by tests",
      confidence: "medium",
    });
  }

  return findings;
}

/** Analyzer entrypoint: language signals + symmetric churn on changed files. */
export async function scanRevertRecurrence(
  req: EnrichRequest,
): Promise<RevertRecurrenceFinding[]> {
  const findings = detectRevertLanguage(req.title, req.body);
  const churn = summarizeFileChurn(req.files ?? []);
  const churnFiles = churn.filter(isSymmetricChurn).map((c) => c.path);
  if (churnFiles.length) {
    findings.push({
      kind: "symmetric-churn",
      detail: `${churnFiles.length} changed file(s) show revert-shaped symmetric churn (large deletions with few additions or vice versa)`,
      files: churnFiles.slice(0, 10),
      confidence: churnFiles.length >= 3 ? "high" : "medium",
    });
  }
  return findings.slice(0, MAX_FINDINGS);
}
