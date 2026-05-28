# GitHub App Setup

The GitHub App is the maintainer surface. GitHub OAuth is the MCP user-auth surface.

## Required Settings

| Field | Value |
| --- | --- |
| Homepage URL | `https://gittensory.aethereal.dev` |
| Webhook URL | `https://api.gittensory.aethereal.dev/v1/github/webhook` |
| Webhook active | Enabled |
| SSL verification | Enabled |
| Install target | Current account or selected organizations |

## Repository Permissions

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Required by GitHub Apps. |
| Pull requests | Read | Inspect PR author, branch, state, and linked context. |
| Issues | Write | Post sticky comments and apply the configured label. |
| Checks | Write | Optional; only needed if a maintainer explicitly enables minimal checks. |

## Events

Subscribe to:

- Pull request
- Issues
- Issue comment
- Repository

If GitHub shows `Installation target`, select it. Some installation-related events are hidden in parts of GitHub’s UI; Gittensory health should not fail on event names that are not selectable.

## Public Behavior

Gittensory inspects PR webhooks quietly first. It publishes a public surface only when the author is confirmed through the official Gittensor API.

- non-miner authors: no comment, no label, no check
- bot authors: no public output
- maintainer-associated authors: skipped unless `includeMaintainerAuthors=true`
- confirmed miners: one sticky public-safe comment plus the configured label, defaulting to `gittensor`

Check runs default to off. If enabled later, they stay minimal and do not include private reviewability, scoring, wallet, hotkey, or reward/risk context.

## Mention Commands

`Issue comment` events let maintainers and authorized PR authors invoke Gittensory explicitly:

- `@gittensory help`
- `@gittensory preflight`
- `@gittensory blockers`
- `@gittensory duplicate-check`
- `@gittensory miner-context`
- `@gittensory next-action`

Replies are public-safe. Private scoreability, reward/risk, wallet, hotkey, raw trust, and maintainer-only reviewability context stay in authenticated MCP/API surfaces.

::: warning Not an official Gittensor frontend
The app adds maintainer workflow context around Gittensor participation. It does not replace the official Gittensor site or dashboard.
:::

## Repair Checklist

1. Update GitHub App permissions and event subscriptions.
2. Reinstall or approve changed permissions on the installed account.
3. Refresh installation health.
4. Confirm comments and labels are enabled only when `Issues: write` is available.
5. Confirm checks are off unless the repo explicitly opted into minimal check runs.
6. Confirm `Issue comment` is subscribed if mention commands should work.
