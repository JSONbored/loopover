ALTER TABLE repository_settings ADD COLUMN ai_review_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE repository_settings ADD COLUMN ai_review_byok INTEGER NOT NULL DEFAULT 0;
