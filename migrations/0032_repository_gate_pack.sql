-- Policy-pack-pluggable gate (#692). `gittensor` (default) = the full Gittensor policy (confirmed-
-- contributor-gated, registry-aware). `oss-anti-slop` = the deterministic rules against any author on any
-- repo, with no Gittensor coupling. Default preserves existing behavior for every current repo.
ALTER TABLE repository_settings ADD COLUMN gate_pack TEXT NOT NULL DEFAULT 'gittensor';
