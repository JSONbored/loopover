-- Linked-issue label propagation (#priority-linked-issue-gate): gittensor:priority is a maintainer
-- reward/bonus label and must never be inferred from a PR's title, changed files, AI output, or
-- existing PR labels -- only ever copied onto a PR when a linked/closing issue already carries the
-- configured issue label. type_labels_json lets a repo override the three TYPE label NAMES
-- (bug/feature/priority); linked_issue_label_propagation_json is the generic, config-driven
-- issue-label -> PR-label mapping that gates priority (and any other configured mapping). Both
-- default to an empty object -- normalized at read time into a safe, complete config (propagation
-- disabled by default, no mappings), so existing repos see no behavior change until they opt in.
ALTER TABLE repository_settings ADD COLUMN type_labels_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE repository_settings ADD COLUMN linked_issue_label_propagation_json TEXT NOT NULL DEFAULT '{}';
