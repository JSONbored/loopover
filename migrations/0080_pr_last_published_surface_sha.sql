-- Over-publish dedup (#4): the head SHA at which a PR's public surface (comment/label/check-run) was LAST
-- published. The scheduled re-gate sweep skips re-reviewing + re-publishing a PR while
-- last_published_surface_sha === head_sha (the surface is already current). Keyed to the head SHA so a push /
-- rebase / force-push (new head) no longer matches → the next sweep re-reviews + re-publishes the new code.
-- NULL = never published. gittensory-computed (publish-written); like approved_head_sha / merge_blocked_sha it is
-- omitted from the GitHub-sync SET clause so a later sync cannot clobber it.
ALTER TABLE pull_requests ADD COLUMN last_published_surface_sha TEXT;
