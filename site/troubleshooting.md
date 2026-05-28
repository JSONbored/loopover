# Troubleshooting

## `gittensory-mcp: command not found`

If the command is not installed globally:

```sh
npm link --workspace @jsonbored/gittensory-mcp
```

Then retry:

```sh
gittensory-mcp doctor
```

If your MCP client does not inherit your shell `PATH`, use an absolute command path in that client config.

## Login Fails

Check:

```sh
gittensory-mcp doctor
gittensory-mcp status
```

GitHub Device Flow must be enabled on the GitHub App or OAuth app configured for Gittensory.

## Session Expired

Run:

```sh
gittensory-mcp login
```

Sessions are intentionally short-lived.

## Source Upload Error

If you see a source-upload error, remove this env var:

```sh
unset GITTENSORY_UPLOAD_SOURCE
```

Gittensory rejects source upload mode in v1.

## GitHub App Installation Needs Attention

Check the installation health endpoint:

```sh
export GITTENSORY_API_URL="https://gittensory-api.aethereal.dev"
curl "$GITTENSORY_API_URL/v1/installations/INSTALLATION_ID/health" \
  -H "Authorization: Bearer $GITTENSORY_API_TOKEN"
```

Fix the reported missing permissions and events, approve the app permission update in GitHub, then refresh installation health.

## Rate Limited

If a command returns `429`, retry after the reported `retry-after` value. Expensive analysis routes have stricter limits than normal read routes.

## Stale Decision Pack

If `decision-pack` returns `needs_snapshot_refresh`, Gittensory has enqueued a rebuild. Retry after the queue drains.
