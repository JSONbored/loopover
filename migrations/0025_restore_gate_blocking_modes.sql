UPDATE repository_settings
SET
  linked_issue_gate_mode = CASE WHEN linked_issue_gate_mode = 'advisory' THEN 'block' ELSE linked_issue_gate_mode END,
  duplicate_pr_gate_mode = CASE WHEN duplicate_pr_gate_mode = 'advisory' THEN 'block' ELSE duplicate_pr_gate_mode END
WHERE gate_check_mode = 'enabled';
