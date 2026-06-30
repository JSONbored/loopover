ALTER TABLE pull_requests ADD COLUMN linked_issue_claimed_at TEXT;

UPDATE pull_requests
SET linked_issue_claimed_at = COALESCE(json_extract(payload_json, '$.updated_at'), updated_at, created_at)
WHERE linked_issues_json IS NOT NULL
  AND linked_issues_json != '[]'
  AND linked_issues_json != '';
