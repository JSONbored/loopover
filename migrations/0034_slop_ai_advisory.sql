-- Opt-in AI-assisted slop advisory (the `slopAiAdvisory` capability). When 1 AND slop_gate_mode != 'off', a
-- free Workers-AI pass adds an ADVISORY-only `ai_slop_advisory` finding for semantic slop the deterministic
-- detector cannot quantify. It NEVER feeds slopRisk or the gate (only the deterministic core can block).
-- Default 0 (off) preserves existing behavior for every current repo; opt-in via `.gittensory.yml`.
ALTER TABLE repository_settings ADD COLUMN slop_ai_advisory INTEGER NOT NULL DEFAULT 0;
