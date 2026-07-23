-- Backtest-regression gate (#8105, epic #8082): advisory by default -- byte-identical behavior for every
-- existing row (the shipped #8138/#8142 comment-only advisory). block escalates a REGRESSED pre-merge
-- backtest verdict into a backtest_regression hard blocker; off silences the backtest advisory entirely.
-- The flip to block is deliberately a config change made only once #8140's persisted track record supports
-- it -- see #8105's own do-not-gate-before-data boundary.
ALTER TABLE repository_settings ADD COLUMN backtest_regression_gate_mode TEXT NOT NULL DEFAULT 'advisory';
