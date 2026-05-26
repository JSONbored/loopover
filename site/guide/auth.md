# Auth

Gittensory has two auth surfaces:

- GitHub OAuth for MCP users.
- GitHub App installation auth for repositories.

## MCP User Auth

Run:

```sh
gittensory-mcp login
```

The CLI starts GitHub Device Flow, asks you to approve the code on GitHub, then exchanges the GitHub token server-side for a short-lived Gittensory session token.

Gittensory stores:

- a hashed server-side session token
- the GitHub login and user id
- scopes and session expiry metadata

Gittensory does not store user PATs.

## Non-Interactive Bootstrap

For local automation, pass a GitHub token only long enough to mint a Gittensory session:

```sh
gittensory-mcp login --github-token "$(gh auth token)"
```

The token is exchanged immediately. The MCP wrapper stores the Gittensory session token, not the GitHub token.

## Check Auth State

```sh
gittensory-mcp whoami
gittensory-mcp status
gittensory-mcp doctor
```

## Logout

```sh
gittensory-mcp logout
```

Logout revokes the remote session when possible and removes the local config file.

## Static Tokens

Static bearer tokens remain only for private backend operations, internal jobs, and temporary beta bootstrap. Normal MCP users should use GitHub OAuth.
