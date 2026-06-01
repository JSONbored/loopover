import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/privacy-security")({
  head: () => ({
    meta: [
      { title: "Privacy & security — Gittensory docs" },
      {
        name: "description",
        content:
          "Gittensory's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:title", content: "Privacy & security — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Gittensory's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:url", content: "/docs/privacy-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/privacy-security" }],
  }),
  component: PrivacySecurity,
});

function PrivacySecurity() {
  return (
    <DocsPage
      eyebrow="Operating"
      title="Privacy & security"
      description="Privacy is the product. These are hard rules, not best-effort goals."
    >
      <h2>Hard rules</h2>
      <ul>
        <li>No source upload by default. MCP sends metadata only.</li>
        <li>No PAT storage. Auth uses GitHub Device Flow.</li>
        <li>No wallet or hotkey display.</li>
        <li>No raw trust-score display.</li>
        <li>No payout/reward guarantees, anywhere.</li>
        <li>No farming language.</li>
        <li>No public score estimates.</li>
        <li>No private reviewability details in public GitHub output.</li>
      </ul>

      <h2>Public output rules</h2>
      <ul>
        <li>At most one sticky sanitized comment per confirmed-miner PR.</li>
        <li>At most one configured label per confirmed-miner PR.</li>
        <li>Public comments are maintainer-friendly and non-shaming.</li>
      </ul>

      <h2>Auth</h2>
      <ul>
        <li>
          Public endpoint: <code>GET /health</code>.
        </li>
        <li>Private API uses Bearer / session tokens.</li>
        <li>MCP CLI uses GitHub OAuth Device Flow.</li>
        <li>Static bearer tokens remain internal / bootstrap only.</li>
      </ul>

      <Callout variant="safety">
        Website copy may discuss private scoreability and risk reasoning, but it's always framed as{" "}
        <strong>private MCP/API context</strong>. The public web never carries score numbers.
      </Callout>
    </DocsPage>
  );
}
