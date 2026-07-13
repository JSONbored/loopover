# Unattended scheduling & failure alerting

`gittensory-miner manage poll` and `gittensory-miner discover` are the two commands most likely to run
**unattended on a schedule**. Unlike `gittensory-miner loop` — a long-running daemon that schedules its own
cycles and is supervised as a persistent service (see the [systemd section in `../DEPLOYMENT.md`](../DEPLOYMENT.md#bare-host-systemd-no-docker)) —
`manage poll` and `discover` are **one-shot**: each runs to completion and exits. That makes them a fit for an
external scheduler (cron or a systemd **timer**), the same one-shot-on-a-timer shape as the
`loopover-docker-prune.*.example` hygiene job in [`systemd/`](../../../systemd/), not a persistent
`Type=simple` service.

This page covers scheduling those commands and alerting when one fails.

## Exit-code contract (what to alert on)

Every miner subcommand exits **`0` on success and non-zero on failure** (the CLI's shared error path returns a
non-zero code for a bad invocation, a store error, or a failed operation). That exit code is the signal to alert
on — both cron and systemd key their failure handling off it, so **no log scraping is required**.

For machine-readable output, pass `--json`: on failure the command prints a structured
`{"ok": false, "error": "<reason>"}` object (and still exits non-zero), so a monitoring wrapper can capture both
the code and the reason:

```sh
gittensory-miner discover --search "good first issue" --json
echo "exit: $?"
```

## cron

A crontab entry runs the command on a fixed schedule. cron does not inherit your login shell's environment, so
set `PATH` (to reach `node`/`gittensory-miner`) and point `GITTENSORY_MINER_CONFIG_DIR` at a stable state
directory. Keep `GITHUB_TOKEN` (and any coding-agent credentials) out of the crontab itself — it is world-listable
via `crontab -l` — by sourcing a root-owned `0600` env file from a wrapper (see below) rather than inlining the
value:

```cron
# m h dom mon dow   command
PATH=/usr/local/bin:/usr/bin:/bin
GITTENSORY_MINER_CONFIG_DIR=/var/lib/gittensory-miner
# Fan out discovery every 15 minutes; send any non-zero exit to MAILTO.
MAILTO=ops@example.com
*/15 * * * *  gittensory-miner-scheduled.sh discover --search "good first issue" >> /var/log/gittensory-miner/discover.log 2>&1

# Poll a specific PR hourly.
0 * * * *     gittensory-miner-scheduled.sh manage poll acme/widgets 1234 >> /var/log/gittensory-miner/poll.log 2>&1
```

**Alerting.** cron mails the job's output to `MAILTO` **only when the command writes to stdout/stderr** — it does
not alert on exit code alone. For exit-code-driven alerting, wrap the command so a non-zero code triggers your
notifier explicitly:

```sh
#!/bin/sh
# /usr/local/bin/gittensory-miner-scheduled.sh — load credentials, run a miner command, alert on failure.
set -a; . /etc/gittensory-miner/miner.env; set +a   # root-owned 0600 file holding GITHUB_TOKEN etc.
if ! gittensory-miner "$@" --json; then
  code=$?
  curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"gittensory-miner $* failed with exit $code on $(hostname)\"}"
  exit "$code"
fi
```

The wrapper appends `--json` itself, so the crontab lines above stay free of both the flag and the credential.

## systemd timer

A systemd **timer** pairs a one-shot service (the command) with a schedule. Mirror the
`loopover-docker-prune.{service,timer}.example` pattern in [`systemd/`](../../../systemd/).

`gittensory-miner-discover.service`:

```ini
[Unit]
Description=gittensory-miner discovery sweep (one-shot)

[Service]
Type=oneshot
# Keep GITHUB_TOKEN (and any coding-agent credentials) in a root-owned 0600 EnvironmentFile, never inline.
EnvironmentFile=/etc/gittensory-miner/miner.env
Environment=GITTENSORY_MINER_CONFIG_DIR=/var/lib/gittensory-miner
ExecStart=/usr/local/bin/gittensory-miner discover --search "good first issue" --json
# Fire an alert handler unit whenever this service exits non-zero (see below).
OnFailure=gittensory-miner-alert@%n.service
```

`gittensory-miner-discover.timer`:

```ini
[Unit]
Description=Run gittensory-miner-discover.service every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true
# Spread the run across hosts instead of firing simultaneously.
RandomizedDelaySec=2m

[Install]
WantedBy=timers.target
```

Install and enable the timer (not the service — the timer starts the service):

```sh
sudo cp gittensory-miner-discover.service gittensory-miner-discover.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gittensory-miner-discover.timer
systemctl list-timers gittensory-miner-discover.timer   # confirm the next run
```

**Alerting.** `OnFailure=` starts the named handler unit whenever the service exits non-zero. A reusable
templated handler (`%i` expands to the failed unit's name) keeps one alert path for every scheduled command:

```ini
# gittensory-miner-alert@.service
[Unit]
Description=Alert on a failed gittensory-miner unit (%i)

[Service]
Type=oneshot
EnvironmentFile=/etc/gittensory-miner/miner.env
ExecStart=/usr/bin/curl -fsS -X POST ${ALERT_WEBHOOK_URL} \
  -H 'content-type: application/json' \
  -d '{"text":"gittensory-miner unit %i failed on %H"}'
```

`journalctl -u gittensory-miner-discover.service` shows the last run's output; `systemctl status` reports the
last exit code.

## Choosing between cron and systemd

- **cron** — simplest when a scheduler already runs and you only need `MAILTO` mail or a wrapper alert.
- **systemd timer** — preferred on a systemd host: `OnCalendar`/`Persistent=true` (catch-up after downtime),
  `RandomizedDelaySec`, journald log capture, and `OnFailure=` exit-code alerting without a wrapper script.

For the always-on autonomous daemon, use `gittensory-miner loop` as a **persistent** service instead — see
[`../DEPLOYMENT.md`](../DEPLOYMENT.md#bare-host-systemd-no-docker). For local-state recovery and concurrency
guarantees, see [`operations-runbook.md`](operations-runbook.md).
