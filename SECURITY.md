# Security

Please do not include secrets, API tokens, private keys, wallet details, webhook payload secrets,
or sensitive contributor evidence in public issues, pull requests, screenshots, or logs.

## Reporting

Use GitHub private vulnerability reporting if it is available on the repository. If it is not
available for your account context, contact the repository owner through a private channel and
include only the minimum reproduction details needed to verify the issue.

## Privacy Posture

- Gittensory does not store user GitHub PATs.
- Public PR comments are sanitized and only posted for officially confirmed Gittensor miners when
  the installed repository settings allow them.
- Detailed contributor evidence belongs in authenticated API and MCP responses only.
- GitHub check runs are public repository surfaces; when enabled, they must stay minimal and
  exclude private reviewability, scoring, wallet, hotkey, and reward/risk context.
- Wallet details, raw trust scores, private rankings, and negative labels must not be published in
  public comments or public issue templates.
- GitHub App private keys, webhook secrets, MCP tokens, API tokens, and internal job tokens must be
  stored as Cloudflare secrets.

## Supported Version

Public support tracks the current `main` branch and the latest published MCP package.
