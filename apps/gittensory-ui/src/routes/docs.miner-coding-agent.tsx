import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

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
  return (
    <DocsPage
      eyebrow="Configuration"
      title="Miner coding-agent driver"
      description="Choose a production provider, override the right model and timeout knobs, and recognize credential failures before you chase the wrong layer."
    >
      <p>
        The miner resolves <code>MINER_CODING_AGENT_PROVIDER</code> as a comma-separated preference
        list. The first configured name wins, unknown names are skipped, and an empty or unset list
        leaves production construction fail-closed instead of guessing a default backend.
      </p>

      <Callout variant="note" title="No silent fallback">
        This seam is explicit on purpose: if you do not configure a provider, the miner does not
        silently pick one for you.
      </Callout>

      <h2>Provider selection</h2>
      <FeatureRow items={MINER_CODING_AGENT_PROVIDER_ITEMS} />
      <CodeBlock
        filename=".env"
        code={`# Prefer Claude Code, fall back to Codex if Claude is unavailable.
MINER_CODING_AGENT_PROVIDER=claude-cli,codex-cli
MINER_CODING_AGENT_CLAUDE_MODEL=<optional-claude-model>
MINER_CODING_AGENT_TIMEOUT_MS=120000

# Prefer Codex, fall back to Claude.
MINER_CODING_AGENT_PROVIDER=codex-cli,claude-cli
MINER_CODING_AGENT_CODEX_MODEL=<optional-codex-model>`}
      />
      <Callout variant="note">
        `noop` and <code>agent-sdk</code> ignore the model and timeout knobs. Only the CLI
        subprocess providers consume them.
      </Callout>

      <h2>Model and timeout overrides</h2>
      <p>
        The only driver-specific knobs today are the provider-specific model overrides and the
        shared wall-clock timeout. Anything else is task-level orchestration, not provider config.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-token-sm">
          <thead>
            <tr className="border-b border-border text-left text-foreground">
              <th className="py-2 pr-4 font-medium">Env var</th>
              <th className="py-2 pr-4 font-medium">Applies to</th>
              <th className="py-2 pr-4 font-medium">Default</th>
              <th className="py-2 pr-0 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {MINER_CODING_AGENT_ENV_ROWS.map((row) => (
              <tr key={row.name} className="border-b border-border/60 align-top last:border-b-0">
                <td className="py-3 pr-4 font-mono text-token-xs text-foreground">{row.name}</td>
                <td className="py-3 pr-4 text-muted-foreground">{row.appliesTo}</td>
                <td className="py-3 pr-4 text-muted-foreground">{row.defaultValue}</td>
                <td className="py-3 pr-0 text-muted-foreground">{row.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recognizing a stale or missing credential</h2>
      <p>
        The shared troubleshooting table for Claude Code and Codex lives on{" "}
        <a href="/docs/self-hosting-ai-providers#recognizing-a-stale-or-missing-credential">
          Self-host AI providers
        </a>
        . This page keeps the miner-specific reminder: the credential lives on the operator's
        machine or mounted volume, not in repo config.
      </p>
      <FeatureRow items={MINER_CODING_AGENT_TRUST_ROWS} />
      <Callout variant="warn" title="Troubleshoot the right layer">
        If the CLI cannot see its credential, the miner cannot spawn a healthy provider. Fix the
        operator-owned credential path first, then come back to the miner env vars.
      </Callout>

      <h2>Related docs</h2>
      <ul>
        <li>
          <Link to="/docs/miner-quickstart">Miner quickstart by lane</Link> — install and verify the
          miner before you wire a coding agent.
        </li>
        <li>
          <Link to="/docs/miner-workflow">Miner workflow</Link> — the rest of the contributor loop
          after the driver is configured.
        </li>
        <li>
          <Link to="/docs/self-hosting-ai-providers">Self-host AI providers</Link> — the broader
          credential and provider reference that shares the troubleshooting table above.
        </li>
      </ul>
    </DocsPage>
  );
}
