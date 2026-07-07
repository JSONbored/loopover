-- Linked-issue hard-rule violation memory (#linked-issue-hard-rule-persistence). resolveLinkedIssueHardRule
-- is a PURE, fully-re-evaluated-from-scratch function: linked issues are re-parsed from the PR's CURRENT body
-- every pass, with no memory of a prior pass's finding. Two ways that let a confirmed violation dodge the
-- flag-then-close verification window (settings.linkedIssueHardRules.closeDelaySeconds): (1) editing the PR
-- body during the grace window to strip the closing reference, so the next pass sees zero linked issues and
-- resolveLinkedIssueHardRule returns undefined; (2) the linked issue's LIVE state changing between the
-- violating pass and the verification pass (e.g. the assignee is removed), so the same issue number
-- re-evaluates clean. Either way, clearLinkedIssueFlag (settings/agent-actions.ts) then removes the
-- pending-closure label as if the violation never happened.
--
-- linked_issue_hard_rule_violated_at is the FIRST time this PR NUMBER was confirmed to violate a hard rule --
-- set once, NEVER cleared, and deliberately NOT scoped to head SHA (mirrors draft_conversion_count, 0118: a
-- fresh commit or an edited body is still the same PR that already proved itself in violation once).
-- linked_issue_hard_rule_violation_reason carries the specific rule text so a later close can still cite it
-- even if the live re-parse can no longer reproduce it (mirrors merge_blocked_reason, 0052's pairing).
ALTER TABLE pull_requests ADD COLUMN linked_issue_hard_rule_violated_at TEXT;
ALTER TABLE pull_requests ADD COLUMN linked_issue_hard_rule_violation_reason TEXT;
