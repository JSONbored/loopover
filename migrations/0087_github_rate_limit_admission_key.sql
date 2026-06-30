ALTER TABLE github_rate_limit_observations
  ADD COLUMN admission_key TEXT;

CREATE INDEX IF NOT EXISTS github_rate_limit_observations_admission_observed_idx
  ON github_rate_limit_observations (admission_key, observed_at);
