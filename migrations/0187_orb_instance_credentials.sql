-- #9121: the "registered instance" trust gate on the published risk-control guarantee authenticated
-- nothing -- instance_id was a plain body-supplied field, checked only against the shared FLEET-WIDE
-- ORB_INGEST_TOKEN every exporter holds. Any holder of that token could present ANY registered instance's
-- id and write (or, via an absent arm, DELETE) that instance's published guarantee. This adds a per-instance
-- credential the collector mints at registration time (returned once, in plaintext, then only its hash is
-- kept) and requires it for every risk-control write. Ordinary outcome/health ingest is UNCHANGED -- it
-- stays open by design (see 0061's own comment); only the risk-control write path now checks this.
ALTER TABLE orb_instances ADD COLUMN ingest_secret_hash TEXT;

-- Per-instance risk-control arms, replacing the two global `system_flags` cells
-- (`riskcontrol:fleet:close` / `riskcontrol:fleet:merge`) that let ANY registered instance overwrite the
-- SAME fleet-wide row. Scoped per instance so one compromised or miscalibrated peer can only ever affect
-- its own row; the public read (loadFleetGuarantee) aggregates across registered instances at query time.
CREATE TABLE IF NOT EXISTS orb_risk_control_arms (
  instance_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id, arm)
);
