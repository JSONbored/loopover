-- #4918: a cost dimension on product_usage_events. Nullable and unset by default -- the vast majority of
-- product actions (viewed a page, ran a preview) have no direct cost; callers that DO know a per-event cost
-- (e.g. an AI-backed action already priced via ai_usage_events.costUsd) can now attach it to the SAME usage
-- row instead of requiring a join. Distinct from ai_usage_events.costUsd, which stays the authoritative,
-- detailed AI-spend ledger (tokens/model/provider) -- this is a lightweight, optional summary figure on the
-- broader, cross-surface usage stream.
ALTER TABLE product_usage_events ADD COLUMN cost_usd REAL;
