import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/miner-coding-agent.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
//
// The three arrays below no longer feed this page's own JSX -- their prose was
// hand-transcribed into the migrated .mdx above -- but they stay exported because
// docs.miner-coding-agent.test.tsx imports them directly (asserting
// MINER_CODING_AGENT_PROVIDER_ITEMS against packages/loopover-engine's
// CODING_AGENT_DRIVER_NAMES, and MINER_CODING_AGENT_ENV_ROWS's env var names). Keep
// both this data and the corresponding MDX content in sync if either changes.
export const MINER_CODING_AGENT_PROVIDER_ITEMS: Array<{ title: string; description: string }> = [
  {
    title: "noop",
    description:
      "Fail-closed stub. Useful when you want the miner to stay off or you are running tests.",
  },
  {
    title: "claude-cli",
    description:
      "Spawns the local `claude` CLI subprocess. Uses `MINER_CODING_AGENT_CLAUDE_MODEL` when set.",
  },
  {
    title: "codex-cli",
    description:
      "Spawns the local `codex` CLI subprocess. Uses `MINER_CODING_AGENT_CODEX_MODEL` when set.",
  },
  {
    title: "agent-sdk",
    description:
      "Runs the in-process Agent SDK path. It ignores the model and timeout overrides on this seam.",
  },
];

export const MINER_CODING_AGENT_ENV_ROWS: Array<{
  name: string;
  appliesTo: string;
  defaultValue: string;
  notes: string;
}> = [
  {
    name: "MINER_CODING_AGENT_PROVIDER",
    appliesTo: "All production provider selection",
    defaultValue: "unset / empty",
    notes:
      "Comma-separated preference list. The first configured name wins; unknown names are skipped.",
  },
  {
    name: "MINER_CODING_AGENT_CLAUDE_MODEL",
    appliesTo: "claude-cli",
    defaultValue: "CLI default",
    notes:
      "Optional override for the Claude Code subprocess. Ignored by noop, codex-cli, and agent-sdk.",
  },
  {
    name: "MINER_CODING_AGENT_CODEX_MODEL",
    appliesTo: "codex-cli",
    defaultValue: "CLI default",
    notes:
      "Optional override for the Codex subprocess. Ignored by noop, claude-cli, and agent-sdk.",
  },
  {
    name: "MINER_CODING_AGENT_TIMEOUT_MS",
    appliesTo: "claude-cli / codex-cli",
    defaultValue: "120000 ms",
    notes:
      "Positive integer wall-clock ceiling. Unset or invalid falls back to the CLI driver's default timeout.",
  },
];

export const MINER_CODING_AGENT_TRUST_ROWS: Array<{ title: string; description: string }> = [
  {
    title: "claude_code_no_oauth_token",
    description:
      "Claude Code cannot find a runtime token. Re-run `claude setup-token` and keep the credential operator-owned.",
  },
  {
    title: "claude_code_error_401",
    description:
      "Claude rejected the token. Generate a fresh one with `claude setup-token` and replace the old secret.",
  },
  {
    title: "codex_no_auth",
    description:
      "Codex cannot find `auth.json`. Re-run `codex auth` on the mounted CLI home or volume.",
  },
  {
    title: "codex_credential_isolation_required",
    description:
      "The Codex home or auth path is not isolated from operator-owned storage. Remove the unsafe override.",
  },
];

export const Route = createFileRoute("/docs/miner-coding-agent")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["miner-coding-agent"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Miner coding-agent driver — LoopOver docs" },
      {
        name: "description",
        content:
          "Enable Claude Code or Codex as the miner's coding-agent driver, and document the provider, model, timeout, and credential troubleshooting paths.",
      },
      { property: "og:title", content: "Miner coding-agent driver — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Enable Claude Code or Codex as the miner's coding-agent driver, and document the provider, model, timeout, and credential troubleshooting paths.",
      },
      { property: "og:url", content: "/docs/miner-coding-agent" },
    ],
    links: [{ rel: "canonical", href: "/docs/miner-coding-agent" }],
  }),
  component: MinerCodingAgentDriverDocs,
});

export function MinerCodingAgentDriverDocs() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Configuration" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
