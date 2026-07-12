-- Local maintainer UI preview seed (#2216).
-- Safe to re-run. Uses a repo under your login so it appears in preview dropdowns.
--
-- After seeding:
--   npx wrangler d1 execute gittensory --local --file=scripts/seed-local-maintainer-preview.sql
-- Then restart `npm run dev` and open /app/maintainer

DELETE FROM pull_requests WHERE repo_full_name = 'andriypolanski/local-preview';
DELETE FROM repository_settings WHERE repo_full_name = 'andriypolanski/local-preview';
DELETE FROM repositories WHERE full_name = 'andriypolanski/local-preview';

INSERT OR REPLACE INTO installations (id, account_login, account_id, target_type, repository_selection, permissions_json, events_json)
VALUES (1, 'andriypolanski', 1, 'User', 'selected', '{}', '[]');

INSERT OR REPLACE INTO installation_health (
  installation_id,
  account_login,
  repository_selection,
  installed_repos_count,
  registered_installed_count,
  status,
  missing_permissions_json,
  missing_events_json,
  permissions_json,
  events_json,
  checked_at
)
VALUES (1, 'andriypolanski', 'selected', 1, 0, 'healthy', '[]', '[]', '{}', '[]', datetime('now'));

INSERT OR REPLACE INTO repositories (full_name, owner, name, installation_id, is_installed, is_registered, is_private)
VALUES ('andriypolanski/local-preview', 'andriypolanski', 'local-preview', 1, 1, 0, 0);

-- Context check ON + standard detail so the readiness table renders in preview.
INSERT OR REPLACE INTO repository_settings (repo_full_name, check_run_mode, check_run_detail_level, public_surface, comment_mode)
VALUES ('andriypolanski/local-preview', 'enabled', 'standard', 'comment_and_label', 'all_prs');

-- Populates the repo dropdown (reviewability list) on the maintainer dashboard.
INSERT OR REPLACE INTO pull_requests (
  id,
  repo_full_name,
  number,
  title,
  state,
  author_login,
  author_association,
  labels_json,
  linked_issues_json
)
VALUES (
  'andriypolanski/local-preview#1',
  'andriypolanski/local-preview',
  1,
  'Sample PR for local UI preview',
  'open',
  'sample-miner',
  'CONTRIBUTOR',
  '["bug"]',
  '[7]'
);
