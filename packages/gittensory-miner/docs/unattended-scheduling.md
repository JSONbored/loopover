# loopover-miner — unattended scheduling & failure alerting

Operational guidance for running the miner's scheduled commands — `manage poll` and `discover` —
unattended on a timer (cron or systemd), and for alerting when a run fails. These are the two commands
most likely to run on a schedule; everything they need is local and they make no interactive prompts.

> **Scope:** scheduling + failure alerting for `manage poll` / `discover`. For local-state recovery see
> [`operations-runbook.md`](operations-runbook.md); for deployment layout see
> [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## The exit-code contract (what to alert on)

Both commands follow the same convention, so any scheduler can detect a failed run from the exit code:

| Exit code | Meaning |
| --- | --- |
| `0` | Success — the command completed. |
| `2` | Failure — invalid arguments, or the run hit an error (network / API / local state). **Alert on this.** |

For scheduled runs, two flags matter:

- `--no-update-check` (or `LOOPOVER_MINER_NO_UPDATE_CHECK=1`) — skip the npm-registry version nudge so
  an unattended run never depends on / prints it.
- `--json` — machine-parseable stdout, so an alert handler can attach the structured output.

## cron

```cron
# crontab env applies to every job below.
MAILTO=you@example.com
LOOPOVER_MINER_NO_UPDATE_CHECK=1

# Poll a tracked PR every 10 minutes. The `||` branch fires on any non-zero exit: it logs the failing
# code to syslog AND re-raises it with `exit "$status"`, so the failure stays visible to exit-status
# monitoring instead of being masked by logger's own success.
*/10 * * * * /usr/local/bin/loopover-miner manage poll acme/widgets 42 --json || { status=$?; logger -t loopover-miner "manage poll failed (exit $status)"; exit "$status"; }

# Discover + enqueue candidate work hourly.
0 * * * * /usr/local/bin/loopover-miner discover --search "label:good-first-issue" --json || { status=$?; logger -t loopover-miner "discover failed (exit $status)"; exit "$status"; }
```

Two cron facts to get right here:

- **`MAILTO` mails *output*, not exit status.** cron emails whatever a job writes to stdout/stderr to
  `MAILTO` — it does not send a message "because" the exit code was non-zero. A job that fails *silently*
  (non-zero exit, no output) produces no mail, so don't rely on `MAILTO` alone as the failure signal.
- **A bare `|| logger …` hides the failure.** `logger` succeeds (exit 0), so `cmd || logger …` makes the
  whole cron job exit 0 — any exit-status-based monitoring then sees success. Capture the code first
  (`status=$?`) and re-raise it (`exit "$status"`) as shown, so the real failing code survives.

## systemd (service + timer)

A `oneshot` service plus a timer is the more observable option: `systemctl status` / `journalctl`
capture each run, and `OnFailure=` is a first-class alerting hook.

`loopover-miner-discover.service`:
```ini
[Unit]
Description=loopover-miner discover
OnFailure=loopover-miner-alert@%n.service

[Service]
Type=oneshot
Environment=LOOPOVER_MINER_NO_UPDATE_CHECK=1
# A non-zero exit (2) marks the unit failed and triggers OnFailure=.
ExecStart=/usr/local/bin/loopover-miner discover --search "label:good-first-issue" --json
```

`loopover-miner-discover.timer`:
```ini
[Unit]
Description=Run loopover-miner discover hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now loopover-miner-discover.timer`.

## Alerting on failure

Every option keys on the same exit-code contract (`2` = failure):

- **cron:** append `|| { status=$?; <alert-command>; exit "$status"; }` (as in the cron example above) —
  capture `$?` before the alert command runs and re-raise it, so the failure isn't masked. Substitute
  `logger` with a webhook `curl`, a PagerDuty/Slack CLI, etc. (`MAILTO` still mails any output, but is not
  a reliable signal for a silent failure — see the cron note above.)
- **systemd:** `OnFailure=loopover-miner-alert@%n.service` runs a templated alert unit on any non-zero
  exit. A minimal alert unit:
  ```ini
  # loopover-miner-alert@.service
  [Service]
  Type=oneshot
  ExecStart=/usr/local/bin/notify-failure "loopover-miner unit %i failed"
  ```
- **wrapper script:** for any scheduler, wrap the command and preserve its exit code:
  ```sh
  #!/bin/sh
  loopover-miner "$@" || { status=$?; notify-failure "loopover-miner $* exited $status"; exit "$status"; }
  ```

Keep `--json` on scheduled runs so the alert handler can forward the structured output; the
human-readable form is for interactive use.
