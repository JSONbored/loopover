import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";
import {
  ACTION_COMMAND_ENTRIES,
  MAINTAINER_COMMAND_ENTRIES,
  PUBLIC_COMMAND_ENTRIES,
} from "@/lib/command-reference";

export const Route = createFileRoute("/docs/gittensory-commands")({
  head: () => ({
    meta: [
      { title: "@gittensory command reference — Gittensory docs" },
      {
        name: "description",
        content:
          "Every @gittensory PR and issue comment command: syntax, default authorization roles, and the hard boundary between auto-review and the one-shot gate.",
      },
      { property: "og:title", content: "@gittensory command reference — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Every @gittensory PR and issue comment command: syntax, default authorization roles, and the hard boundary between auto-review and the one-shot gate.",
      },
      { property: "og:url", content: "/docs/gittensory-commands" },
    ],
    links: [{ rel: "canonical", href: "/docs/gittensory-commands" }],
  }),
  component: GittensoryCommandsReference,
});

const DEFAULT_ROLE_SUMMARY: Record<string, string> = {
  help: "maintainer, collaborator, confirmed_miner (default policy)",
  ask: "maintainer, collaborator, confirmed_miner",
  preflight: "maintainer, collaborator, confirmed_miner",
  blockers: "maintainer, collaborator, confirmed_miner",
  "duplicate-check": "maintainer, collaborator, confirmed_miner",
  "miner-context": "maintainer, collaborator, confirmed_miner",
  "next-action": "maintainer, collaborator, confirmed_miner",
  reviewability: "maintainer, collaborator, confirmed_miner",
  "repo-fit": "maintainer, collaborator, confirmed_miner",
  packet: "maintainer, collaborator, confirmed_miner",
  "queue-summary": "maintainer, collaborator",
  "confirmed-miners": "maintainer, collaborator",
  "review-now": "maintainer, collaborator",
  "needs-author": "maintainer, collaborator",
  "duplicate-clusters": "maintainer, collaborator",
  "burden-forecast": "maintainer, collaborator",
  "intake-health": "maintainer, collaborator",
  "outcome-patterns": "maintainer, collaborator",
  "noise-report": "maintainer, collaborator",
  "gate-override": "maintainer, collaborator",
  review: "maintainer, collaborator, confirmed_miner",
  pause: "maintainer, collaborator",
  resume: "maintainer, collaborator",
  resolve: "maintainer, collaborator",
  configuration: "maintainer, collaborator",
  explain: "maintainer, collaborator",
};

function CommandTable({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<{ id: string; title: string; description: string }>;
}) {
  return (
    <>
      <h2>{title}</h2>
      <div className="not-prose overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="py-2 pr-4 font-medium">Syntax</th>
              <th className="py-2 pr-4 font-medium">Effect</th>
              <th className="py-2 font-medium">Default roles</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-hairline align-top">
                <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                  @gittensory {entry.id}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">{entry.description}</td>
                <td className="py-2 text-muted-foreground">{DEFAULT_ROLE_SUMMARY[entry.id] ?? "see policy"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GittensoryCommandsReference() {
  return (
    <DocsPage
      eyebrow="Commands"
      title="@gittensory command reference"
      description="The full PR and issue-comment control surface: Q&A verbs, maintainer digests, and PR action commands. Roles reflect the shipped default policy; maintainers can override per command in .gittensory.yml."
    >
      <Callout variant="safety" title="Gate vs auto-review">
        Commands never flip the gate to advisory and never bypass the one-shot disposition.{" "}
        <code>pause</code> and <code>resume</code> affect only auto-review scheduling — not gate enforcement.
        See <Link to="/docs/how-reviews-work">How reviews work</Link> for the gate/review split.
      </Callout>

      <h2>Syntax</h2>
      <p>
        Post a comment on a pull request (or issue thread) mentioning <code>@gittensory</code> followed by a
        verb. Trailing free text becomes the command argument where noted (for example{" "}
        <code>@gittensory ask what should I fix first?</code>).
      </p>
      <CodeBlock code={`@gittensory <verb> [argument or reason]`} />

      <CommandTable title="Public Q&A commands" entries={PUBLIC_COMMAND_ENTRIES} />
      <CommandTable title="Maintainer queue digests" entries={MAINTAINER_COMMAND_ENTRIES} />
      <CommandTable title="PR action commands" entries={ACTION_COMMAND_ENTRIES} />

      <h2>Per-command authorization overrides</h2>
      <p>
        Default allowed roles ship in the worker configuration. A maintainer can tighten or widen a single verb
        via <code>commandAuthorization</code> in <code>.gittensory.yml</code> (resolved in the same order as
        other per-repo settings: manifest → database → defaults).
      </p>
      <CodeBlock
        lang="yaml"
        code={`commandAuthorization:
  default: [maintainer, collaborator, confirmed_miner]
  commands:
    review: [maintainer, collaborator, confirmed_miner]
    pause: [maintainer, collaborator]
    gate-override: [maintainer, collaborator]`}
      />
      <p>
        Maintainer-only digest verbs ignore a plain <code>pr_author</code> role even when widened — only
        maintainer, collaborator, and confirmed_miner survive the clamp for those commands.
      </p>

      <h2>Related docs</h2>
      <ul>
        <li>
          <Link to="/docs/maintainer-workflow">Maintainer workflow</Link> — when to invoke commands in a PR
          thread
        </li>
        <li>
          <Link to="/docs/how-reviews-work">How reviews work</Link> — gate, dual-AI review, and unified comment
        </li>
        <li>
          <Link to="/docs/tuning">Tuning your reviews</Link> — per-repo review and agent execution modes
        </li>
      </ul>
    </DocsPage>
  );
}
