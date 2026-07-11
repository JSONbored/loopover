# Docker Compose secret files

Native, orchestrator-managed secret storage for the self-host stack (`docker-compose.yml`'s
top-level `secrets:` block), per the "Prefer secret files" guidance on
[/docs/self-hosting-security](https://gittensory.aethereal.dev/docs/self-hosting-security).

## Why

Putting a real secret's *value* directly in `.env` means it's readable via `docker inspect`,
`docker compose config`, and any process on the host with access to the container's environment.
Mounting it as a **file** instead keeps the value out of both — the container only ever sees a
path, and the app reads the file's contents itself at startup.

## How it works

Every secret below is optional and additive. **Nothing here is required** — if you're not ready to
set up secret files, leave `.env` exactly as it is today (`GITHUB_APP_PRIVATE_KEY=...` etc. inline)
and this directory has no effect. `docker-compose.yml` sets a `<NAME>_FILE=/run/secrets/<name>`
default for every secret listed below, but the app's existing generic loader
(`src/selfhost/load-file-secrets.ts`) only ever reads the file when the plain `<NAME>` variable is
**not already set** — an inline `.env` value always wins. So the two mechanisms coexist safely:
migrate one secret at a time, or never migrate at all.

To use a secret file instead of an inline `.env` value:

1. Remove (or leave commented) the plain `<NAME>=...` line in `.env`.
2. Write the raw secret value into the matching file below, with no surrounding quotes and no
   trailing newline requirement (the loader trims whitespace):
   ```sh
   printf '%s' 'your-real-secret-value' > secrets/github_webhook_secret.txt
   ```
   For the GitHub App private key specifically, write the full PEM file as-is:
   ```sh
   cp /path/to/your-downloaded-key.pem secrets/github_app_private_key.pem
   ```
3. Restart the `gittensory` service (`docker compose up -d --no-deps gittensory`, or run
   `./scripts/selfhost-update.sh`).

Every file below is `chmod 600`-worthy — the init script that creates the empty placeholders
(`scripts/selfhost-init-secrets.sh`) does this for you; keep that permission if you edit a file by
hand afterward.

## Files

| File | Env var | Purpose |
|---|---|---|
| `github_app_private_key.pem` | `GITHUB_APP_PRIVATE_KEY_FILE` | Your GitHub App's private key (PEM). |
| `github_webhook_secret.txt` | `GITHUB_WEBHOOK_SECRET_FILE` | HMAC key GitHub webhook deliveries are verified against. |
| `gittensory_api_token.txt` | `GITTENSORY_API_TOKEN_FILE` | Server-to-server API bearer token. |
| `gittensory_mcp_token.txt` | `GITTENSORY_MCP_TOKEN_FILE` | Shared MCP bearer token. |
| `internal_job_token.txt` | `INTERNAL_JOB_TOKEN_FILE` | Gates internal-only routes (e.g. `/v1/internal/*`). |
| `selfhost_setup_token.txt` | `SELFHOST_SETUP_TOKEN_FILE` | Unlocks the first-run `/setup` wizard. |
| `token_encryption_secret.txt` | `TOKEN_ENCRYPTION_SECRET_FILE` | AES-256-GCM master secret for maintainer BYOK keys at rest. |
| `draft_token_encryption_secret.txt` | `DRAFT_TOKEN_ENCRYPTION_SECRET_FILE` | AES-256-GCM secret for the contributor OAuth token (draft flow). |
| `orb_enrollment_secret.txt` | `ORB_ENROLLMENT_SECRET_FILE` | One-time enrollment secret for brokered Orb mode. |
| `pagerduty_routing_key.txt` | `PAGERDUTY_ROUTING_KEY_FILE` | PagerDuty Events API v2 routing key (experimental paging integration). |

This is not the full list of every secret-shaped env var the stack supports (AI provider API keys,
Discord/Slack webhooks, Postgres/Grafana credentials for their optional profiles, etc.) — it covers
the vars used by the always-on `gittensory` service. The same `<NAME>_FILE` convention works for any
of those too; add a matching `secrets:` entry in `docker-compose.yml` (or a
`docker-compose.override.yml`) if you want the same treatment for one of them.

## Never commit real files here

Everything in this directory except this README is gitignored. `scripts/selfhost-init-secrets.sh`
only ever creates **empty** placeholder files (so `docker compose build`/`up` never fails on a
missing file) — it never overwrites a file that already exists, so it's always safe to re-run.
