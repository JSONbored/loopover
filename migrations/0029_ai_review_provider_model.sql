-- Config-as-code BYOK provider/model for the AI review (the secret key stays in repository_ai_keys,
-- encrypted; these are the non-secret choices, settable via .gittensory.yml or the maintainer dashboard).
ALTER TABLE repository_settings ADD COLUMN ai_review_provider TEXT;
ALTER TABLE repository_settings ADD COLUMN ai_review_model TEXT;
