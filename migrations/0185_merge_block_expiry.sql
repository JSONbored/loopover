-- #9012: an infra-scoped terminal merge failure (401 installation-token rejection, exhausted secondary
-- rate-limit window) is a property of the installation, not of the commit -- it fails every in-flight merge in
-- the fleet at once and heals for all of them at once. Before this column, every terminal class wrote a
-- head-scoped block whose ONLY escape was the contributor pushing a new commit, so one token rotation
-- permanently stranded every green, approved PR it caught, invisibly. An infra block now carries an expiry and
-- is re-probed once the window passes; a commit-scoped block (real conflict, repo merge policy) leaves this
-- NULL and keeps the original until-a-new-commit semantics.
ALTER TABLE pull_requests ADD COLUMN merge_blocked_until TEXT;
