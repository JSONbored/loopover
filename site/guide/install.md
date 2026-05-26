# Install

Gittensory has two install paths: private beta from the repository, and public npm once the package is intentionally launched.

## Private Beta

Use this while `JSONbored/gittensory` is still private.

```sh
git clone https://github.com/JSONbored/gittensory.git
cd gittensory
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp status
```

After login, start the MCP server with:

```sh
gittensory-mcp --stdio
```

The login command uses GitHub Device Flow and stores a short-lived Gittensory session token in your local config directory.

## Public npm

This path is prepared but stays disabled until public launch.

```sh
npx @jsonbored/gittensory-mcp login
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp status
gittensory-mcp --stdio
```

The package should remain restricted until the launch gate passes. Public launch means changing npm publish access to `public`, bumping the MCP package version, and publishing from the release workflow.

## Verify The Install

Run:

```sh
gittensory-mcp doctor
gittensory-mcp whoami
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json
```

`doctor` checks API health, auth state, source-upload defaults, local git metadata, and whether the binary is likely visible to MCP clients.

## Privacy Defaults

Gittensory MCP v1 sends structured metadata only:

- repository full name
- branch and base refs
- changed file paths and counts
- linked issue references
- commit messages
- validation command summaries

It does not upload source contents. `GITTENSORY_UPLOAD_SOURCE=true` is rejected.
