-- Multi-tenant hosted productization (#1028): repo settings + BYOK must isolate by installation, not only by
-- repo_full_name. Rebuild both tables with an installation_id discriminator and migrate legacy rows into the
-- null-installation lane for self-host / pre-hosted compatibility.

ALTER TABLE repository_settings RENAME TO repository_settings_legacy;

CREATE TABLE repository_settings (
  repo_full_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL DEFAULT 0,
  comment_mode TEXT NOT NULL DEFAULT 'detected_contributors_only',
  public_audience_mode TEXT NOT NULL DEFAULT 'oss_maintainer',
  public_signal_level TEXT NOT NULL DEFAULT 'standard',
  check_run_mode TEXT NOT NULL DEFAULT 'off',
  check_run_detail_level TEXT NOT NULL DEFAULT 'minimal',
  gate_check_mode TEXT NOT NULL DEFAULT 'off',
  gate_pack TEXT NOT NULL DEFAULT 'gittensor',
  linked_issue_gate_mode TEXT NOT NULL DEFAULT 'block',
  duplicate_pr_gate_mode TEXT NOT NULL DEFAULT 'block',
  quality_gate_mode TEXT NOT NULL DEFAULT 'advisory',
  quality_gate_min_score INTEGER,
  slop_gate_mode TEXT NOT NULL DEFAULT 'off',
  merge_readiness_gate_mode TEXT NOT NULL DEFAULT 'off',
  manifest_policy_gate_mode TEXT NOT NULL DEFAULT 'off',
  first_time_contributor_grace INTEGER NOT NULL DEFAULT 0,
  slop_gate_min_score INTEGER,
  slop_ai_advisory INTEGER NOT NULL DEFAULT 0,
  ai_review_mode TEXT NOT NULL DEFAULT 'off',
  ai_review_byok INTEGER NOT NULL DEFAULT 0,
  ai_review_provider TEXT,
  ai_review_model TEXT,
  auto_label_enabled INTEGER NOT NULL DEFAULT 1,
  gittensor_label TEXT NOT NULL DEFAULT 'gittensor',
  create_missing_label INTEGER NOT NULL DEFAULT 1,
  public_surface TEXT NOT NULL DEFAULT 'comment_and_label',
  include_maintainer_authors INTEGER NOT NULL DEFAULT 0,
  require_linked_issue INTEGER NOT NULL DEFAULT 0,
  backfill_enabled INTEGER NOT NULL DEFAULT 1,
  private_trust_enabled INTEGER NOT NULL DEFAULT 1,
  badge_enabled INTEGER NOT NULL DEFAULT 0,
  command_authorization_json TEXT NOT NULL DEFAULT '{}',
  autonomy_json TEXT NOT NULL DEFAULT '{}',
  auto_maintain_json TEXT NOT NULL DEFAULT '{}',
  agent_paused INTEGER NOT NULL DEFAULT 0,
  agent_dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO repository_settings (
  repo_full_name, installation_id, comment_mode, public_audience_mode, public_signal_level, check_run_mode,
  check_run_detail_level, gate_check_mode, gate_pack, linked_issue_gate_mode, duplicate_pr_gate_mode,
  quality_gate_mode, quality_gate_min_score, slop_gate_mode, merge_readiness_gate_mode,
  manifest_policy_gate_mode, first_time_contributor_grace, slop_gate_min_score, slop_ai_advisory,
  ai_review_mode, ai_review_byok, ai_review_provider, ai_review_model, auto_label_enabled, gittensor_label,
  create_missing_label, public_surface, include_maintainer_authors, require_linked_issue, backfill_enabled,
  private_trust_enabled, badge_enabled, command_authorization_json, autonomy_json, auto_maintain_json,
  agent_paused, agent_dry_run, created_at, updated_at
)
SELECT
  repo_full_name, 0, comment_mode,
  COALESCE(public_audience_mode, 'oss_maintainer'),
  COALESCE(public_signal_level, 'standard'),
  COALESCE(check_run_mode, 'off'),
  COALESCE(check_run_detail_level, 'minimal'),
  COALESCE(gate_check_mode, 'off'),
  COALESCE(gate_pack, 'gittensor'),
  COALESCE(linked_issue_gate_mode, 'block'),
  COALESCE(duplicate_pr_gate_mode, 'block'),
  COALESCE(quality_gate_mode, 'advisory'),
  quality_gate_min_score,
  COALESCE(slop_gate_mode, 'off'),
  COALESCE(merge_readiness_gate_mode, 'off'),
  COALESCE(manifest_policy_gate_mode, 'off'),
  COALESCE(first_time_contributor_grace, 0),
  slop_gate_min_score,
  COALESCE(slop_ai_advisory, 0),
  COALESCE(ai_review_mode, 'off'),
  COALESCE(ai_review_byok, 0),
  ai_review_provider,
  ai_review_model,
  COALESCE(auto_label_enabled, 1),
  COALESCE(gittensor_label, 'gittensor'),
  COALESCE(create_missing_label, 1),
  COALESCE(public_surface, 'comment_and_label'),
  COALESCE(include_maintainer_authors, 0),
  COALESCE(require_linked_issue, 0),
  COALESCE(backfill_enabled, 1),
  COALESCE(private_trust_enabled, 1),
  COALESCE(badge_enabled, 0),
  COALESCE(command_authorization_json, '{}'),
  COALESCE(autonomy_json, '{}'),
  COALESCE(auto_maintain_json, '{}'),
  COALESCE(agent_paused, 0),
  COALESCE(agent_dry_run, 0),
  created_at,
  updated_at
FROM repository_settings_legacy;

DROP TABLE repository_settings_legacy;

CREATE UNIQUE INDEX repository_settings_repo_installation_unique
  ON repository_settings (repo_full_name, installation_id);
CREATE INDEX repository_settings_repo_updated_idx
  ON repository_settings (repo_full_name, updated_at);

ALTER TABLE repository_ai_keys RENAME TO repository_ai_keys_legacy;

CREATE TABLE repository_ai_keys (
  repo_full_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  last4 TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO repository_ai_keys (
  repo_full_name, installation_id, provider, ciphertext, iv, salt, key_version, model, last4, created_by, created_at, updated_at
)
SELECT
  repo_full_name, 0, provider, ciphertext, iv, salt, COALESCE(key_version, 1), model, last4, created_by, created_at, updated_at
FROM repository_ai_keys_legacy;

DROP TABLE repository_ai_keys_legacy;

CREATE UNIQUE INDEX repository_ai_keys_repo_installation_unique
  ON repository_ai_keys (repo_full_name, installation_id);
CREATE INDEX repository_ai_keys_repo_updated_idx
  ON repository_ai_keys (repo_full_name, updated_at);
