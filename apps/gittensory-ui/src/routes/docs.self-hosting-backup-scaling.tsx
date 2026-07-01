import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-backup-scaling")({
  head: () => ({
    meta: [
      { title: "Self-host backup and scaling — Gittensory docs" },
      {
        name: "description",
        content:
          "Back up and scale the self-hosted Gittensory review service with SQLite, Litestream, Postgres, Redis, and restore checks.",
      },
      { property: "og:title", content: "Self-host backup and scaling — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Back up and scale the self-hosted Gittensory review service with SQLite, Litestream, Postgres, Redis, and restore checks.",
      },
      { property: "og:url", content: "/docs/self-hosting-backup-scaling" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-backup-scaling" }],
  }),
  component: SelfHostingBackupScaling,
});

function SelfHostingBackupScaling() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Backup and scaling"
      description="Choose the right data layout for one node or many, and make sure the review state can be restored."
    >
      <h2>Default: SQLite single node</h2>
      <p>
        SQLite is the default because it is operationally simple and good enough for a single
        maintainer instance. The tradeoff is obvious: if the volume is lost, review state is lost.
      </p>
      <Callout variant="warn">
        Do not treat the default data volume as a backup. Snapshot it or enable continuous backup.
      </Callout>

      <h2>Continuous backup with Litestream</h2>
      <CodeBlock
        filename=".env"
        code={`BACKUP_ACKNOWLEDGED=true
LITESTREAM_ACCESS_KEY_ID=<key>
LITESTREAM_SECRET_ACCESS_KEY=<secret>
LITESTREAM_ENDPOINT=s3.example.com
LITESTREAM_REGION=us-east-1`}
      />
      <CodeBlock lang="bash" code={`docker compose --profile litestream up -d`} />

      <h2>Scheduled backups</h2>
      <p>
        The bundled <code>backup</code> profile writes the active app database to the{" "}
        <code>gittensory-backups</code> volume. SQLite installs use an online backup; Postgres
        installs use <code>pg_dump</code>. The same run also snapshots Qdrant when it is enabled.
      </p>
      <CodeBlock lang="bash" code={`docker compose --profile backup up -d`} />

      <h2>Multi-instance: Postgres and Redis</h2>
      <FeatureRow
        items={[
          {
            title: "Postgres",
            description:
              "Use DATABASE_URL for a shared database and queue claiming with SKIP LOCKED semantics.",
          },
          {
            title: "Redis",
            description:
              "Use REDIS_URL for distributed rate limiting, webhook deduplication, and shared short-lived caches.",
          },
          {
            title: "PgBouncer",
            description:
              "Use the pgbouncer profile when many replicas need pooled database connections.",
          },
        ]}
      />
      <CodeBlock
        filename=".env"
        code={`POSTGRES_PASSWORD=<password>
DATABASE_URL=postgres://gittensory:<password>@pgbouncer:5432/gittensory
REDIS_URL=redis://redis:6379
QDRANT_URL=http://qdrant:6333`}
      />
      <CodeBlock lang="bash" code={`docker compose --profile pgbouncer --profile qdrant up -d`} />

      <h2>One-time SQLite to Postgres copy</h2>
      <p>
        Existing SQLite installs can copy state into a fresh Postgres database with the bundled
        migrator. It dry-runs by default and only commits when <code>--execute</code> is present.
      </p>
      <CodeBlock
        lang="bash"
        code={`npm run selfhost:postgres:migrate -- --sqlite /data/gittensory.sqlite --postgres-url "$DATABASE_URL"
npm run selfhost:postgres:migrate -- --sqlite /data/gittensory.sqlite --postgres-url "$DATABASE_URL" --execute`}
      />

      <h2>Restore checks</h2>
      <ul>
        <li>Restore to a separate host or volume, never over the live instance first.</li>
        <li>
          Boot the app and confirm <code>/ready</code> returns 200.
        </li>
        <li>Confirm migrations do not fail or reapply incorrectly.</li>
        <li>Confirm recent review rows and job state are present.</li>
      </ul>

      <p>
        After scaling, revisit <Link to="/docs/self-hosting-operations">Operations</Link> and{" "}
        <Link to="/docs/self-hosting-security">Security</Link> because network and credential
        boundaries change.
      </p>
    </DocsPage>
  );
}
