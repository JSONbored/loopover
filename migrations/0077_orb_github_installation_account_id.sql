-- Store the immutable GitHub account id for the Orb App installation owner. Logins can be renamed and
-- eventually reused, so OAuth self-enrollment must bind the admin check to this stable id as well.
ALTER TABLE orb_github_installations ADD COLUMN account_id INTEGER;
