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
      <p>
        PgBouncer pools connections <em>between instances and Postgres</em>. Each app instance still
        opens its own connection pool to whatever it's pointed at (PgBouncer or Postgres directly),
        shared by every HTTP handler and queue worker in that instance — set <code>PGPOOL_MAX</code>{" "}
        (default 10) if a single instance needs more headroom than that under real concurrency (many
        registered repos, higher <code>QUEUE_CONCURRENCY</code>). Raise it gradually and watch for{" "}
        <code>GittensoryPostgresConnectionPressure</code>: that alert means you're approaching
        Postgres's own <code>max_connections</code>, a different ceiling than this per-instance pool
        size.
      </p>

      <h2>One-time SQLite to Postgres copy</h2>
      <p>
        Existing SQLite installs can copy state into a fresh Postgres database with the bundled
        migrator. It dry-runs by default and only commits when <code>--execute</code> is present.
      </p>
      <CodeBlock
        lang="bash"
        code={`export DATABASE_URL=postgres://gittensory:<password>@pgbouncer:5432/gittensory
npm run selfhost:postgres:migrate -- --sqlite /data/gittensory.sqlite
npm run selfhost:postgres:migrate -- --sqlite /data/gittensory.sqlite --execute`}
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

      <h2>Verify a backup is restorable</h2>
      <p>
        The <code>backup</code> profile ships <code>verify-backup.sh</code>, which checks the newest
        backup without touching the live database: Postgres <code>.dump</code> archives with{" "}
        <code>pg_restore --list</code>, and SQLite <code>.sqlite.gz</code> backups with a gzip and{" "}
        <code>integrity_check</code> pass. Run it against the newest backup, or a specific file:
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile backup run --rm backup sh /verify-backup.sh
docker compose --profile backup run --rm backup sh /verify-backup.sh /backups/postgres/gittensory-<timestamp>.dump`}
      />
      <p>
        A healthy run ends with <code>[verify] postgres archive OK: … (N TOC entries)</code> (or{" "}
        <code>[verify] sqlite backup OK</code>), then <code>[verify] complete</code>, and exits 0.
        Corruption, a missing backup, or an empty archive exits non-zero with a{" "}
        <code>[verify]</code> reason.
      </p>
      <p>
        To prove a dump actually restores, opt into a scratch restore into a <em>throwaway</em>{" "}
        database — never the live one:
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile backup run --rm \\
  -e VERIFY_RESTORE_SCRATCH=1 \\
  -e GITTENSORY_VERIFY_SCRATCH_DATABASE_URL=postgres://user:pass@host:5432/gittensory_verify \\
  backup sh /verify-backup.sh`}
      />
      <Callout variant="warn">
        The scratch restore runs <code>pg_restore --clean</code> against{" "}
        <code>GITTENSORY_VERIFY_SCRATCH_DATABASE_URL</code>, so point it at a dedicated database you
        can afford to drop. The script refuses to run when that URL equals the live backup source.
      </Callout>

      <h2>Restore drill: what "restore-tested" actually verifies</h2>
      <p>
        This exact flow was run against a real production backup on a live instance on 2026-07-04
        (backup <code>gittensory-20260704T090939Z.dump</code>): the dump was restored into a
        throwaway, network-isolated scratch database (a separate container, never the live one),
        which the script's own identity check confirmed was distinct from the backup source before
        touching anything. The restore completed cleanly and, at the time of this drill, repopulated
        all 84 application tables, including the largest operational tables with their full row
        counts intact (hundreds of thousands of rows in the biggest tables) — not just an empty
        schema. Table and row counts will grow over time; treat them as a point-in-time result, not
        an invariant.
      </p>
      <p>
        This proves the backup content and the restore path both work end-to-end against real data.
        It deliberately stops short of booting a full app instance against the scratch database and
        polling <code>/ready</code>: that endpoint also gates on live Redis, Qdrant, the configured
        AI provider, Codex auth, and a real GitHub App key (see{" "}
        <Link to="/docs/self-hosting-operations">Operations</Link>'s health endpoints section) —
        reproducing all of those for a disposable scratch instance would mean copying real
        credentials into new, throwaway infrastructure, which is a bigger risk than the drill is
        worth. This drill proves the dump can be restored and its contents inspected at the database
        layer — it does not exercise the app's own <code>db</code> readiness probe, migration boot
        path, or <code>/ready</code> response. A full disaster-recovery rehearsal still needs to
        verify app readiness on the target infrastructure, using the operator's own real
        credentials.
      </p>

      <p>
        After scaling, revisit <Link to="/docs/self-hosting-operations">Operations</Link> and{" "}
        <Link to="/docs/self-hosting-security">Security</Link> because network and credential
        boundaries change.
      </p>
    </DocsPage>
  );
}
