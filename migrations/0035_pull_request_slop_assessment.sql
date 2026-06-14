-- Persist the latest deterministic slop assessment per cached pull request so the maintainer dashboard can
-- surface a slop score row without re-fetching changed files on every load. Written by the public-surface
-- processor ONLY when the repo opted into slop (slop_gate_mode != 'off'); NULL means "not assessed". These
-- are gittensory-COMPUTED signals, deliberately omitted from the GitHub-sync upsert's SET clause so a
-- subsequent sync never clobbers them.
ALTER TABLE pull_requests ADD COLUMN slop_risk INTEGER;
ALTER TABLE pull_requests ADD COLUMN slop_band TEXT;
