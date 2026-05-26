# GitHub App Setup

The GitHub App is the maintainer/install surface. GitHub OAuth is the MCP user-auth surface.

## Basic Fields

Use these values for private beta:

| Field | Value |
| --- | --- |
| Homepage URL | `https://gittensory-api.zeronode.workers.dev` |
| Webhook URL | `https://gittensory-api.zeronode.workers.dev/v1/github/webhook` |
| Webhook active | enabled |
| SSL verification | enabled |
| Device Flow | enabled |

Use a generated webhook secret and set the same value in Cloudflare as `GITHUB_WEBHOOK_SECRET`.

## Required Repository Permissions

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Required for repository identity and repository events. |
| Checks | Write | Required to create and update the Gittensory check run. |
| Pull requests | Read | Required for PR metadata, reviewability, and webhook events. |
| Issues | Read | Required for issue linkage, issue-discovery context, and duplicate signals. |

Optional:

| Permission | Access | Why |
| --- | --- | --- |
| Issues | Write | Only needed if public-safe sticky PR comments are enabled. |
| Contents | Read | Only needed if a future feature reads repository files directly through the App. |

## Required Events

Subscribe to:

- Pull request
- Issues
- Repository

If GitHub shows `Installation target`, select it. Some installation-related events are not always shown as normal selectable event rows; Gittensory should not block health on event names that are hidden in the app UI.

## Install Or Repair

1. Update the GitHub App permissions and events.
2. Reinstall the app or approve the changed permissions.
3. Select the repos Gittensory should inspect.
4. Trigger installation-health refresh:

```sh
curl -X POST "$GITTENSORY_API_URL/v1/internal/jobs/refresh-installation-health/run" \
  -H "Authorization: Bearer $INTERNAL_JOB_TOKEN"
```

5. Check health:

```sh
curl "$GITTENSORY_API_URL/v1/readiness" \
  -H "Authorization: Bearer $GITTENSORY_API_TOKEN"
```

Healthy app installation state should remove the readiness warning about GitHub App installations needing attention.

## Marketplace Readiness

Before Marketplace submission, add:

- public docs URL
- support contact
- privacy policy
- terms page if needed
- clear setup flow
- valid webhook and install diagnostics

Do not submit while Gittensory is private beta or invite-only.
