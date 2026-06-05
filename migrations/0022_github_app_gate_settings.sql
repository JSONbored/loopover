ALTER TABLE repository_settings ADD COLUMN public_audience_mode TEXT NOT NULL DEFAULT 'oss_maintainer';
ALTER TABLE repository_settings ADD COLUMN gate_check_mode TEXT NOT NULL DEFAULT 'off';
