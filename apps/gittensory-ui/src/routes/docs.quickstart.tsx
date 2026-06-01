import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/quickstart")({
  head: () => ({
    meta: [
      { title: "Quickstart — Gittensory docs" },
      {
        name: "description",
        content:
          "Install @jsonbored/gittensory-mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
      },
      { property: "og:title", content: "Quickstart — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Install @jsonbored/gittensory-mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
      },
      { property: "og:url", content: "/docs/quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/quickstart" }],
  }),
  component: Quickstart,
});

function Quickstart() {
  return (
    <DocsPage
      eyebrow="Get started"
      title="Quickstart"
      description="Install the MCP, sign in, and run your first analysis. About two minutes."
    >
      <h2>1. Install</h2>
      <p>
        The MCP is published as <code>@jsonbored/gittensory-mcp</code>. You can run it with{" "}
        <code>npx</code>, or install it globally.
      </p>
      <CodeBlock
        code={`# one-off
npx -y @jsonbored/gittensory-mcp --help

# install
npm i -g @jsonbored/gittensory-mcp`}
      />

      <h2>2. Sign in (GitHub Device Flow)</h2>
      <p>
        Gittensory never asks for a Personal Access Token. The CLI walks you through GitHub's Device
        Flow and exchanges the result for a Gittensory session token.
      </p>
      <CodeBlock
        code={`gittensory-mcp login
gittensory-mcp whoami
gittensory-mcp status`}
      />
      <Callout variant="safety">
        Session tokens are <strong>Gittensory tokens backed by GitHub identity</strong>, not your
        GitHub PATs. You can log out anytime with <code>gittensory-mcp logout</code>.
      </Callout>

      <h2>3. Run your first analysis</h2>
      <p>Analyze the current branch with metadata only. No source ever leaves your machine.</p>
      <CodeBlock
        code={`gittensory-mcp doctor
gittensory-mcp analyze-branch --login your-login --json
gittensory-mcp preflight --login your-login --json`}
      />

      <h2>4. Wire it into your coding agent</h2>
      <p>
        Print a config snippet for your editor of choice and paste it in. See{" "}
        <a href="/docs/mcp-clients">MCP client setup</a> for the details.
      </p>
      <CodeBlock
        code={`gittensory-mcp init-client --target codex
gittensory-mcp init-client --target claude-desktop
gittensory-mcp init-client --target cursor`}
      />
    </DocsPage>
  );
}
