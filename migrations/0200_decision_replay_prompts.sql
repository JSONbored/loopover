-- #9028 (epic #8828, Replay v2): the exact system prompt sent to the model, for re-query action matching.
--
-- The public decision record commits to the prompt via `promptDigest` (sha256 of the ACTUAL
-- buildSystemPrompt output for that call, #9124) -- a contributor can verify the commitment, but a digest
-- cannot be re-queried. `scripts/replay-decision.ts --requery` needs the text itself to re-run the model for
-- the same target and report an ACTION-MATCH RATE (never "reproducibility": hosted inference is not
-- bit-deterministic even at temperature 0, and the docs say so).
--
-- DELIBERATELY A PRIVATE SIBLING TABLE, mirroring decision_replay_inputs' posture exactly (#8838): the
-- prompt embeds the full diff plus contributor content, so it must never live in the public record. Row-size
-- is why it is ALSO not a decision_replay_inputs column: prompts run to hundreds of KB, and pinning them to
-- the replay-input row would drag that table's every read through the blob.
--
-- Retention is 30 days (src/db/retention.ts), deliberately SHORTER than decision_replay_inputs' 180: the
-- re-query mode is an operator debugging tool for RECENT decisions, the blob is the largest and most
-- sensitive artifact in the replay family, and the public promptDigest commitment outlives the text forever.
CREATE TABLE IF NOT EXISTS decision_replay_prompts (
  record_id   TEXT PRIMARY KEY,            -- decision_records.id (record:<owner/repo>#<pr>@<head sha>)
  prompt_json TEXT NOT NULL,               -- { systemPrompt } -- exactly what was sent, nothing derived
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_replay_prompts_created_at ON decision_replay_prompts(created_at);
