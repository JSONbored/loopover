# gittensory-miner — unattended scheduling & failure alerting

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

- `--no-update-check` (or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`) — skip the npm-registry version nudge so
  an unattended run never depends on / prints it.
- `--json` — machine-parseable stdout, so an alert handler can attach the structured output.

## cron

```cron
# crontab env applies to every job below.
MAILTO=you@example.com
GITTENSORY_MINER_NO_UPDATE_CHECK=1

# Poll a tracked PR every 10 minutes. cron mails the output to MAILTO on any non-zero exit; the
# `|| logger` fallback also records the failure (with the command's exit code) to syslog for alerting.
*/10 * * * * /usr/local/bin/gittensory-miner manage poll acme/widgets 42 --json || logger -t gittensory-miner "manage poll failed (exit $?)"

# Discover + enqueue candidate work hourly.
0 * * * * /usr/local/bin/gittensory-miner discover --search "label:good-first-issue" --json || logger -t gittensory-miner "discover failed (exit $?)"
```

In `cmd || logger "... $?"`, `$?` on the right of `||` is the exit code of `cmd` (the `||` branch runs
immediately after `cmd` fails), so it logs the real failing code.

## systemd (service + timer)

A `oneshot` service plus a timer is the more observable option: `systemctl status` / `journalctl`
capture each run, and `OnFailure=` is a first-class alerting hook.

`gittensory-miner-discover.service`:
```ini
[Unit]
Description=gittensory-miner discover
OnFailure=gittensory-miner-alert@%n.service

[Service]
Type=oneshot
Environment=GITTENSORY_MINER_NO_UPDATE_CHECK=1
# A non-zero exit (2) marks the unit failed and triggers OnFailure=.
ExecStart=/usr/local/bin/gittensory-miner discover --search "label:good-first-issue" --json
```

`gittensory-miner-discover.timer`:
```ini
[Unit]
Description=Run gittensory-miner discover hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now gittensory-miner-discover.timer`.

## Alerting on failure

Every option keys on the same exit-code contract (`2` = failure):

- **cron:** set `MAILTO`, and/or append `|| <alert-command>` — the examples use `logger`; substitute a
  webhook `curl`, a PagerDuty/Slack CLI, etc.
- **systemd:** `OnFailure=gittensory-miner-alert@%n.service` runs a templated alert unit on any non-zero
  exit. A minimal alert unit:
  ```ini
  # gittensory-miner-alert@.service
  [Service]
  Type=oneshot
  ExecStart=/usr/local/bin/notify-failure "gittensory-miner unit %i failed"
  ```
- **wrapper script:** for any scheduler, wrap the command and branch on `$?`:
  ```sh
  #!/bin/sh
  gittensory-miner "$@" || { notify-failure "gittensory-miner $* exited $?"; exit 1; }
  ```

Keep `--json` on scheduled runs so the alert handler can forward the structured output; the
human-readable form is for interactive use.
