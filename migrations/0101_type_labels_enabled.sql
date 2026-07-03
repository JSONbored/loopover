-- Label decoupling (#label-decoupling): the per-PR TYPE label (gittensor:bug/feature/priority,
-- classified from the PR title + changed paths) was previously gated by autoLabelEnabled nested
-- inside decidePublicSurface's public-contributor-surface decision -- so miner-detection status,
-- publicAudienceMode, or a maintainer-authored PR could silently suppress it, even though type
-- labels are internal triage metadata meant to apply unconditionally. This column independently
-- controls the type label, separate from autoLabelEnabled (the base gittensor context label).
-- Default true matches the prior de-facto behavior (autoLabelEnabled defaults true too), so
-- existing repos see no behavior change until they explicitly opt out.
ALTER TABLE repository_settings ADD COLUMN type_labels_enabled INTEGER NOT NULL DEFAULT 1;
