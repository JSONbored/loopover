-- Opt-in deterministic anti-slop gate (#530/#532). `slop_gate_mode`: off (default) | advisory (surface the
-- slop score + warnings in context) | block (also hard-block when slopRisk >= slop_gate_min_score). Default
-- 'off' preserves existing behavior for every current repo; the threshold defaults to the 'high' band (60).
ALTER TABLE repository_settings ADD COLUMN slop_gate_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE repository_settings ADD COLUMN slop_gate_min_score INTEGER;
