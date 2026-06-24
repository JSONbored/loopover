-- Per-repo gate mode for self-authored linked issues (#self-authored-linked-issue-gate).
-- When `advisory` (default), the `self_authored_linked_issue` finding is surfaced in the review
-- panel but never blocks the gate — no behavior change for existing repos. When `block`, the gate
-- closes the PR when the contributor opens a PR that links an issue they themselves filed.
ALTER TABLE repository_settings ADD COLUMN self_authored_linked_issue_gate_mode TEXT NOT NULL DEFAULT 'advisory';
