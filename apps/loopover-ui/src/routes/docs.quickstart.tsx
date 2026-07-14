import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/quickstart")({
  head: () => ({
    meta: [
      { title: "Quickstart — LoopOver docs" },
      {
        name: "description",
        content:
          "Install @loopover/mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
      },
      { property: "og:title", content: "Quickstart — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Install @loopover/mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
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
        The MCP is published as <code>@loopover/mcp</code>. You can run it with <code>npx</code>, or
        install it globally.
      </p>
      <CodeBlock
        code={`# one-off
npx -y @loopover/mcp@latest --help

# install
npm i -g @loopover/mcp@latest`}
      />

      <h2>2. Sign in (GitHub Device Flow)</h2>
      <p>
        LoopOver never asks for a Personal Access Token. The CLI walks you through GitHub's Device
        Flow and exchanges the result for a LoopOver session token.
      </p>
      <CodeBlock
        code={`loopover-mcp login
loopover-mcp whoami
loopover-mcp status`}
      />
      <Callout variant="safety">
        Session tokens are <strong>LoopOver tokens backed by GitHub identity</strong>, not your
        GitHub PATs. You can log out anytime with <code>loopover-mcp logout</code>.
      </Callout>

      <h2>3. Run your first analysis</h2>
      <p>Analyze the current branch with metadata only. No source ever leaves your machine.</p>
      <CodeBlock
        code={`loopover-mcp doctor
loopover-mcp analyze-branch --login your-login --json
loopover-mcp preflight --login your-login --json`}
      />

      <h2>4. Wire it into your coding agent</h2>
      <p>
        Print a config snippet for your editor of choice and paste it in. See{" "}
        <a href="/docs/mcp-clients">MCP client setup</a> for the details. For the full miner path
        (plan → preflight → packet) and other roles, see{" "}
        <a href="/docs/beta-onboarding">Beta onboarding</a>.
      </p>
      <CodeBlock
        code={`loopover-mcp init-client --print codex
loopover-mcp init-client --print claude
loopover-mcp init-client --print cursor`}
      />
    </DocsPage>
  );
}
