ALTER TABLE agent_recommendation_outcomes ADD COLUMN source TEXT NOT NULL DEFAULT 'inferred';

CREATE INDEX IF NOT EXISTS agent_recommendation_outcomes_actor_source_idx
  ON agent_recommendation_outcomes(actor_login, source, updated_at);
