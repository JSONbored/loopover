-- #9160: durable per-(PR, issue) claim ledger. pull_requests.linked_issue_claimed_at is a single PR-level
-- timestamp that BLENDS every currently-linked issue into one value -- resolveLinkedIssueClaimedAt preserves
-- it whenever the new linked-issue set overlaps the old one, so a PR that claimed issue #1 on day 1 and later
-- adds "Fixes #7" keeps the day-1 timestamp for #7 too. That lets an attacker keep a long-lived PR linking a
-- throwaway issue, then edit its body to add a victim's valuable issue and inherit a backdated claim time,
-- stealing the duplicate-cluster winner slot (queue/duplicate-detection.ts, packages/loopover-engine's
-- duplicate-winner election).
--
-- Each row here is written ONCE, immutably, the first time loopover observes THIS SPECIFIC (repo, PR, issue)
-- triple (INSERT OR IGNORE) -- so a newly-added issue always gets its own fresh claim time regardless of what
-- the blended pull_requests column says. The duplicate-winner election reads this table, scoped to only the
-- issue(s) actually contested with a sibling, instead of the blended PR-level value.
CREATE TABLE IF NOT EXISTS linked_issue_claims (
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, pull_number, issue_number)
);

-- Backfill: seed one row per currently-linked issue from the existing blended pull_requests column (same
-- COALESCE chain 0084_pull_request_linked_issue_claimed_at.sql used), so an issue already linked before this
-- migration keeps its historical relative ordering intact instead of silently resetting to "whenever this PR
-- next happens to re-sync" the first time recordLinkedIssueClaims runs post-deploy. This is exactly as
-- backdated as today's pre-fix behavior for these PRE-EXISTING rows (no worse) -- the fix's actual benefit (a
-- NEWLY-added issue getting its own fresh, un-backdatable clock) applies going forward, from each PR's next
-- sync onward.
INSERT OR IGNORE INTO linked_issue_claims (repo_full_name, pull_number, issue_number, claimed_at)
SELECT pr.repo_full_name, pr.number, CAST(je.value AS INTEGER), COALESCE(pr.linked_issue_claimed_at, pr.updated_at, pr.created_at)
FROM pull_requests pr, json_each(pr.linked_issues_json) je
WHERE pr.linked_issues_json IS NOT NULL
  AND pr.linked_issues_json != '[]'
  AND pr.linked_issues_json != '';
