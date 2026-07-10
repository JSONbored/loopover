-- Contributor skill-file link for the screenshot-table gate (#4540 follow-up). Appended to the
-- AUTO-GENERATED rejection message (both matrix and presence mode) so a closed contributor always gets
-- pointed at the exact evidence contract, not just told evidence is missing. Nullable, same "no override
-- configured" shape as screenshot_table_gate_message (migration 0117) -- deliberately a SEPARATE field
-- from that one: message is a full replacement a maintainer uses for total control over the wording,
-- while skill_file_url only ever appends to whichever message is already being shown (auto-generated,
-- specific-missing-pairs text included), so setting one doesn't cost the other.
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_skill_file_url TEXT;
