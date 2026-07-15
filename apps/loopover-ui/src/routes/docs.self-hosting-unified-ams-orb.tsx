import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

const DESCRIPTION =
  "Run ORB (self-hosted PR review) and AMS (the autonomous miner) together on one host — shared state, aligned .env, and working AMS Grafana panels in fleet mode.";

export const Route = createFileRoute("/docs/self-hosting-unified-ams-orb")({
  head: () => ({
    meta: [
      { title: "Unified ORB + AMS self-host — LoopOver docs" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Unified ORB + AMS self-host — LoopOver docs" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: "/docs/self-hosting-unified-ams-orb" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-unified-ams-orb" }],
  }),
  component: UnifiedAmsOrb,
});

function UnifiedAmsOrb() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Running ORB and AMS together"
      description="ORB (self-hosted PR review) and AMS (the autonomous miner) each run on their own, but there is one combined setup that closes the loop on a single host — with shared on-disk state so the AMS observability panels actually populate."
    >
      <p>Two compose files are involved, and they are deliberately separate:</p>
      <FeatureRow
        items={[
          {
            title: "ORB — root docker-compose.yml",
            description:
              "The self-hosted review service (app + Redis, plus opt-in profiles for Postgres, Caddy, observability, and more).",
          },
          {
            title: "AMS — packages/loopover-miner/docker-compose.miner.yml",
            description:
              "The fleet-mode miner: a long-lived worker built from the package Dockerfile, state on a named miner-data volume.",
          },
        ]}
      />
      <p>
        Standing both up on one host is just two <code>docker compose</code> invocations. The one
        thing that needs care is <strong>where AMS keeps its SQLite state</strong>, because the ORB{" "}
        <code>ams-observability</code> exporter reads that state from a host directory — and fleet
        mode does not write there by default.
      </p>

      <h2>1. Bring up ORB</h2>
      <p>
        Follow the <Link to="/docs/self-hosting-quickstart">Self-hosting quickstart</Link> to
        configure ORB's <code>.env</code> and boot the stack. For this combined setup, enable both
        the <code>observability</code> profile (Prometheus, Alertmanager, Loki, and Grafana) and the{" "}
        <code>ams-observability</code> profile (the <code>ams-reporting-exporter</code> that feeds
        AMS data into Grafana):
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile observability --profile ams-observability up -d
curl http://localhost:8787/ready`}
      />
      <Callout variant="note">
        Grafana itself ships under <code>--profile observability</code>; the AMS exporter that
        populates its AMS datasources ships under <code>--profile ams-observability</code>. Enable
        both, or the AMS panels stay empty even though the rest of the observability stack is up.
      </Callout>

      <h2>2. Bring up AMS in fleet mode</h2>
      <p>
        Fleet mode reads credentials from an env file and runs the continuous worker loop. Build and
        start it from the repo root:
      </p>
      <CodeBlock
        lang="bash"
        code={`cp packages/loopover-miner/.loopover-miner.env.example packages/loopover-miner/.loopover-miner.env
# edit .loopover-miner.env: set GITHUB_TOKEN (+ optional provider keys)
docker compose -f packages/loopover-miner/docker-compose.miner.yml up -d --build`}
      />
      <p>
        On its own this works — but the miner's SQLite ledgers now live in a Docker{" "}
        <strong>named volume</strong> (<code>miner-data</code>), whose real host path is a
        Docker-managed internal detail. The ORB exporter, meanwhile, reads the ledgers from a host
        directory (default <code>~/.config/loopover-miner</code>), so the two never line up on their
        own and the Grafana AMS datasources stay <strong>silently empty</strong>.
      </p>

      <h2>3. Bridge the state so AMS panels populate</h2>
      <p>
        The AMS package ships an opt-in override that relocates the fleet miner's{" "}
        <code>/data/miner</code> state onto the <em>same</em> host directory the exporter reads —
        using the same <code>LOOPOVER_MINER_CONFIG_DIR</code> variable and default, so there is no{" "}
        <code>docker volume inspect</code> archaeology. Copy the example (it is gitignored) and run
        all three compose files together with both profiles:
      </p>
      <CodeBlock
        lang="bash"
        code={`cp packages/loopover-miner/docker-compose.miner.override.yml.example \\
   packages/loopover-miner/docker-compose.miner.override.yml   # edit the host path only for a non-default location

docker compose \\
  -f docker-compose.yml \\
  -f packages/loopover-miner/docker-compose.miner.yml \\
  -f packages/loopover-miner/docker-compose.miner.override.yml \\
  --profile observability --profile ams-observability up -d`}
      />
      <p>
        The override bind-mounts <code>/data/miner</code> to{" "}
        <code>${"{LOOPOVER_MINER_CONFIG_DIR:-~/.config/loopover-miner}"}</code> — Compose merges by
        container path, so this <em>replaces</em> the base file's <code>miner-data</code>{" "}
        named-volume mount for the same target rather than adding a second one. The exporter's own
        bind is the same source:{" "}
        <code>${"{LOOPOVER_MINER_CONFIG_DIR:-~/.config/loopover-miner}"}:/ams-ledgers:ro</code>.
        Both sides now read one location.
      </p>
      <Callout variant="warn" title="The two files must agree on LOOPOVER_MINER_CONFIG_DIR">
        Leave <code>LOOPOVER_MINER_CONFIG_DIR</code> unset on both to use the shared default, or set
        it once so both the fleet miner and the ORB exporter follow it. If only one side sets it,
        they diverge again and the AMS panels go empty — this is the mismatch the fleet-mode bridge
        exists to close.
      </Callout>

      <h2>4. Verify the AMS panels</h2>
      <FeatureRow
        items={[
          {
            title: "Miner state on the host",
            description:
              "Confirm ~/.config/loopover-miner/ (or your LOOPOVER_MINER_CONFIG_DIR) now contains the miner's SQLite files (attempt-log.sqlite3, prediction-ledger.sqlite3, …) written by the fleet container.",
          },
          {
            title: "Exporter is running",
            description:
              "`docker compose ps` shows ams-reporting-exporter up; it re-exports the reporting DBs on LOOPOVER_AMS_REPORTING_EXPORT_INTERVAL_SECONDS (default 30s).",
          },
          {
            title: "Grafana AMS datasources",
            description:
              "Open Grafana (from the observability profile) and confirm the AMS attempt-log / prediction-ledger panels now show data rather than an empty series.",
          },
        ]}
      />
      <Callout variant="note">
        This is the fleet-mode bridge that <code>#5805</code> introduced; the AMS-deployment
        reference in <code>packages/loopover-miner/DEPLOYMENT.md</code> ("Running fleet mode
        alongside ORB's ams-observability profile") documents the same override for a
        package-internal audience. Laptop-mode AMS already writes to{" "}
        <code>~/.config/loopover-miner</code> directly and needs no override — only fleet mode's
        named volume does.
      </Callout>
    </DocsPage>
  );
}
