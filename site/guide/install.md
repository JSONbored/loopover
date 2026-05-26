# Install

Start here when you want Gittensory available from Codex, Claude Desktop, Cursor, or another stdio MCP client.

## 3-Step Quick Start

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp doctor
```

Then run the server:

```sh
gittensory-mcp --stdio
```

`login` uses GitHub Device Flow and stores a short-lived Gittensory session token locally. It does not store a user PAT.

::: tip No source upload by default
MCP v1 sends repository metadata, changed file paths, counts, linked issue refs, commit messages, and validation summaries. It does not upload source contents.
:::

## Configure A Client

Print a client snippet without editing local config files:

```sh
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
```

If a client cannot find `gittensory-mcp`, use an absolute command path in that client’s MCP config.

## Verify In A Repo

From any GitHub repository:

```sh
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json
gittensory-mcp preflight --login YOUR_GITHUB_LOGIN --json
```

Use `doctor` when auth, PATH, API reachability, or git metadata looks wrong.

## Local Development

Use this only when working on Gittensory itself:

```sh
git clone https://github.com/JSONbored/gittensory.git
cd gittensory
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp login
```
