-- Gittensory Orb (#1255) — instance registration gate, modeled on das-github-mirror's `registered=false`
-- default. Every self-host instance that POSTs anonymized batches to /v1/orb/ingest is recorded here on
-- first contact, but its signals only count toward fleet calibration once an operator REGISTERS it
-- (registered=1). This is the fleet's trust anchor: ingest stays open + frictionless (no shared secret —
-- the topology has no per-instance key the collector could verify), but a stranger — or a ring of them —
-- cannot move the fleet median until a human opts them in. Signals are still stored for everyone (so a
-- later registration is retroactive); computeFleetAnalytics is what filters to registered instances.
CREATE TABLE IF NOT EXISTS orb_instances (
  instance_id TEXT PRIMARY KEY NOT NULL,
  -- 0 until an operator opts the instance into fleet calibration; computeFleetAnalytics counts only registered.
  registered INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  registered_at TEXT
);

CREATE INDEX IF NOT EXISTS orb_instances_registered_idx ON orb_instances(registered);
