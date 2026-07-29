# Docker Compose secret files

Native, orchestrator-managed secret storage for the self-host stack (`docker-compose.yml`'s
top-level `secrets:` block), per the "Prefer secret files" guidance on
[/docs/self-hosting-security](https://loopover.ai/docs/self-hosting-security).

## Why

Putting a real secret's *value* directly in `.env` means it's readable via `docker inspect`,
`docker compose config`, and any process on the host with access to the container's environment.
Mounting it as a **file** instead keeps the value out of both — the container only ever sees a
path, and the app reads the file's contents itself at startup.

**Tradeoff, stated plainly:** these files are `chmod 644` (world-readable on the host), not `600`.
Standalone Docker Compose's `secrets:` is a plain bind mount under the hood — it cannot remap
in-container ownership the way Swarm secrets can, and the container reads the file as its own uid
(the image's `node` user), which is essentially never the uid of whoever deployed it. `600` would
just make the file unreadable to the app itself (confirmed against a real deploy — this is exactly
what happened the first time this shipped: every secret read failed with
`selfhost_secret_file_unreadable`). `644` is the minimum that works without requiring your host to
have a matching uid/group. In exchange you get: not visible via `docker inspect` / `docker compose
config` / a full container env dump, at the cost of: readable by any OTHER local user with a shell
on this host, not just the deploying account — a genuinely wider bar than `.env` itself (typically
`600`, owner-only). If that tradeoff is unacceptable for your threat model (a shared/multi-tenant
host), keep using inline `.env` values instead — this feature is entirely optional, see below.

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
2. Get a real value into the matching file below. For most of them, running
   `./scripts/selfhost-init-secrets.sh` (#4928) already did this step for you — it generates a
   random value for every file EXCEPT `github_app_private_key.pem`, `orb_enrollment_secret.txt`,
   `pagerduty_routing_key.txt`, and `claude_code_oauth_token.txt` (those four come from an external
   party, so there's no "generate" step — write the real issued value in yourself):
   ```sh
   printf '%s' 'your-real-secret-value' > secrets/orb_enrollment_secret.txt
   ```
   For the GitHub App private key specifically, write the full PEM file as-is:
   ```sh
   cp /path/to/your-downloaded-key.pem secrets/github_app_private_key.pem
   ```
3. Restart the `loopover` service (`docker compose up -d --no-deps loopover`, or run
   `./scripts/selfhost-update.sh`).

Leave each file at the `644` the init script (`scripts/selfhost-init-secrets.sh`) sets by default —
see the tradeoff explained above for why `600` breaks the app's own ability to read it back.

## Rotating a secret (#9543)

**Use `./scripts/rotate-secret.sh` rather than editing these files by hand** — it enforces both of the
rules below, backs the old value up, and verifies the running container actually picked the change up:

```sh
printf '%s' 'sk-ant-oat01-your-new-token' | ./scripts/rotate-secret.sh claude_code_oauth_token
```

If you do edit by hand, two rules matter, and getting either wrong fails **silently** — the container
stays healthy and the status stays green while every review quietly degrades to the fallback provider:

1. **The file must contain the bare value and nothing else.** The loader
   (`src/selfhost/load-file-secrets.ts`) only `.trim()`s — it does not strip comments and does not pick a
   line. A label line above the value becomes *part of the credential*. To annotate which account a
   credential belongs to, use a sidecar file (`claude_code_oauth_token.label`); it is ignored by
   everything and gitignored the same as the secret itself.
2. **Write in place; never write-new-then-rename.** A Compose `secrets:` entry is a plain bind mount
   pinned to the **inode**. `printf '%s' … > file` truncates in place and the running container sees the
   new bytes immediately. `mv` (and the default save behaviour of several editors) creates a *new* inode
   and leaves the container serving the old value — and `docker compose up -d` will **not** repair it, as
   it prints `Container Running` and changes nothing when the Compose config is unchanged. Recovering
   from that needs `docker compose up -d --no-deps --force-recreate loopover`.

**No restart is needed for `claude_code_oauth_token`** — it is re-read from this file on every AI call
(`resolveClaudeOauthToken` in `src/selfhost/ai.ts`). Codex is likewise already hot: its `auth.json` lives
in the `loopover-data` volume and is re-resolved per call. Every other secret here is materialised into
the environment once at boot, so those do still need the service recreated.

Two other ways to rotate, both covering the same ground without an SSH session:

- **`loopover_admin_rotate_secret`** (MCP) — drives the host-side redeploy companion over its existing
  Unix socket. Requires `LOOPOVER_MCP_ADMIN_TOKEN` + `LOOPOVER_MCP_ADMIN_ENABLED` and an installed
  companion. The app container cannot write these files itself: the mount is read-only.
- **`POST /v1/internal/provider-credentials/claude-code`** — the *fleet* path. Stores the credential
  encrypted at rest (same AES-256-GCM envelope as the BYOK provider keys) so every instance resolves it
  fresh at call time; a multi-instance deployment has no shared filesystem for the file path to use.
  A stored credential takes precedence over this file; `DELETE` clears it and falls back here.

## Files

| File | Env var | Purpose |
|---|---|---|
| `github_app_private_key.pem` | `GITHUB_APP_PRIVATE_KEY_FILE` | Your GitHub App's private key (PEM). |
| `github_webhook_secret.txt` | `GITHUB_WEBHOOK_SECRET_FILE` | HMAC key GitHub webhook deliveries are verified against. |
| `loopover_api_token.txt` | `LOOPOVER_API_TOKEN_FILE` | Server-to-server API bearer token. |
| `loopover_mcp_token.txt` | `LOOPOVER_MCP_TOKEN_FILE` | Shared MCP bearer token. |
| `loopover_mcp_admin_token.txt` | `LOOPOVER_MCP_ADMIN_TOKEN_FILE` | Higher-privilege MCP admin token (config read/write tools); inert unless `LOOPOVER_MCP_ADMIN_ENABLED` is also set. |
| `redeploy_companion_token.txt` | `REDEPLOY_COMPANION_TOKEN_FILE` | Shared secret with the host-side redeploy companion (`systemd/loopover-redeploy-companion.service.example`) -- copy the SAME value into that unit's `EnvironmentFile`, it is not two independent secrets. |
| `internal_job_token.txt` | `INTERNAL_JOB_TOKEN_FILE` | Gates internal-only routes (e.g. `/v1/internal/*`). |
| `selfhost_setup_token.txt` | `SELFHOST_SETUP_TOKEN_FILE` | Unlocks the first-run `/setup` wizard. |
| `token_encryption_secret.txt` | `TOKEN_ENCRYPTION_SECRET_FILE` | AES-256-GCM master secret for maintainer BYOK keys at rest. |
| `draft_token_encryption_secret.txt` | `DRAFT_TOKEN_ENCRYPTION_SECRET_FILE` | AES-256-GCM secret for the contributor OAuth token (draft flow). |
| `orb_enrollment_secret.txt` | `ORB_ENROLLMENT_SECRET_FILE` | One-time enrollment secret for brokered Orb mode. |
| `pagerduty_routing_key.txt` | `PAGERDUTY_ROUTING_KEY_FILE` | PagerDuty Events API v2 routing key (experimental paging integration). |
| `claude_code_oauth_token.txt` | `CLAUDE_CODE_OAUTH_TOKEN_FILE` | Claude Code subscription OAuth token (from `claude setup-token`), used when `AI_PROVIDER=claude-code`. |

This is not the full list of every secret-shaped env var the stack supports (AI provider API keys,
Discord/Slack webhooks, Postgres/Grafana credentials for their optional profiles, etc.) — it covers
the vars used by the always-on `loopover` service. The same `<NAME>_FILE` convention works for any
of those too; add a matching `secrets:` entry in `docker-compose.yml` (or a
`docker-compose.override.yml`) if you want the same treatment for one of them.

## Never commit real files here

Everything in this directory except this README is gitignored. `scripts/selfhost-init-secrets.sh`
generates a real random value for each self-generatable file (so `docker compose build`/`up`
never fails on a missing file, and boots without any manual `openssl` step) and creates only an
**empty** placeholder for the four externally-issued ones it can't generate a usable value for. Those
four placeholders are safe to leave empty: the app treats an empty file for `GITHUB_APP_PRIVATE_KEY_FILE`,
`ORB_ENROLLMENT_SECRET_FILE`, `PAGERDUTY_ROUTING_KEY_FILE`, or `CLAUDE_CODE_OAUTH_TOKEN_FILE` as "not
configured", skips it, and logs a `selfhost_secret_file_empty_optional` warning naming the variable. An empty
file for any OTHER secret is still a hard boot failure -- there it can only mean a truncated write, which
would otherwise leave you running with a credential that silently reads as unset. Either
way, it only ever touches the *permissions* of a file that is still empty, never its content — the
moment a real value lands in one (written by the script or by you), both the content and whatever
mode you set are left alone on every future run. Always safe to re-run.
