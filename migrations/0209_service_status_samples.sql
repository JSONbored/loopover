-- #9985 (slice 2 of #9747): the source for "has it been healthy?".
--
-- /v1/public/service-status answers "is each component healthy RIGHT NOW" by reading Alertmanager's active
-- alerts. It cannot answer the past tense, because there is nothing to read: Alertmanager serves active
-- alerts only, resolved ones are gone, there is no Prometheus on the box (metrics flow through the
-- otel-collector), and nothing persisted a history. #9983 therefore published no uptime figure rather than
-- deriving one from a single live sample.
--
-- This is that history: one row per component per cron tick. Uptime and incidents are DERIVED from these
-- rows rather than posted by hand, which is what #9747 means by "incidents appear without manual posting".
--
-- `status` carries the same vocabulary the endpoint publishes -- operational | degraded | outage | unknown --
-- and `unknown` is stored rather than skipped ON PURPOSE. A tick where the alerting source could not be read
-- is UNMEASURED time, not healthy time and not an outage; dropping those rows would silently shrink the
-- window and let a period of blindness read as uptime. Keeping them is what lets the read path report
-- coverage separately from the percentage.
--
-- No UNIQUE on (component, sampled_at): two ticks in the same second are harmless to an aggregate over
-- contiguous runs, whereas a constraint violation on a best-effort telemetry write is not.
CREATE TABLE IF NOT EXISTS service_status_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  component   TEXT NOT NULL,
  status      TEXT NOT NULL,
  sampled_at  TEXT NOT NULL
);

-- The read is always "this component, over this trailing window, in time order", which this covers exactly.
CREATE INDEX IF NOT EXISTS service_status_samples_component_time
  ON service_status_samples (component, sampled_at);

-- The retention prune deletes by age alone (`sampled_at < cutoff`, across every component), so it needs an
-- index LEADING with that column -- the composite above leads with `component` and cannot serve it. Both
-- exist because the two access patterns are genuinely different: the read is always per-component over a
-- window, the prune is always all-components before a cutoff. test/unit/retention.test.ts enforces the
-- latter for every table in RETENTION_POLICY, which is how the omission surfaced.
CREATE INDEX IF NOT EXISTS service_status_samples_sampled_at
  ON service_status_samples (sampled_at);
