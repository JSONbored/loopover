import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/ams-deployment")({
  head: () => ({
    meta: [
      { title: "AMS deployment — LoopOver docs" },
      {
        name: "description",
        content:
          "Run @loopover/miner in laptop mode or fleet mode: Docker build, Compose scaling, secret files, bare-host systemd, and bridging into the ams-observability profile.",
      },
      { property: "og:title", content: "AMS deployment — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Run @loopover/miner in laptop mode or fleet mode: Docker build, Compose scaling, secret files, bare-host systemd, and bridging into the ams-observability profile.",
      },
      { property: "og:url", content: "/docs/ams-deployment" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-deployment" }],
  }),
  component: AmsDeployment,
});

function AmsDeployment() {
  return (
    <DocsPage
      eyebrow="Miners"
      title="AMS deployment"
      description="Two form factors for running @loopover/miner: laptop mode (single machine, zero Docker) and fleet mode (containerized workers with a shared data volume)."
    >
      <p>
        Both are 100% client-side for core operation — the miner never uploads source and never
        requires a hosted LoopOver callback to boot. Credentials (GitHub tokens, etc.) stay on the
        operator's machine or in their own secret store; nothing is baked into images.
      </p>
      <div className="not-prose overflow-x-auto">
        <table className="w-full border-collapse text-token-sm">
          <thead>
            <tr className="border-hairline text-left text-token-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium"></th>
              <th className="py-2 pr-4 font-medium">Laptop mode</th>
              <th className="py-2 font-medium">Fleet mode</th>
            </tr>
          </thead>
          <tbody className="divide-hairline">
            <tr className="align-top">
              <td className="py-2 pr-4 font-medium text-foreground">Best for</td>
              <td className="py-2 pr-4 text-muted-foreground">
                One contributor machine, local experimentation
              </td>
              <td className="py-2 text-muted-foreground">
                Many parallel miner attempts on a host or small cluster
              </td>
            </tr>
            <tr className="align-top">
              <td className="py-2 pr-4 font-medium text-foreground">Dependencies</td>
              <td className="py-2 pr-4 text-muted-foreground">
                Node.js <code>&gt;=22.13.0</code> only
              </td>
              <td className="py-2 text-muted-foreground">
                Docker (or compatible runtime) + Node image or custom image
              </td>
            </tr>
            <tr className="align-top">
              <td className="py-2 pr-4 font-medium text-foreground">State</td>
              <td className="py-2 pr-4 text-muted-foreground">
                SQLite files under <code>~/.config/loopover-miner/</code> (override with{" "}
                <code>LOOPOVER_MINER_CONFIG_DIR</code>)
              </td>
              <td className="py-2 text-muted-foreground">
                Same SQLite layout on a mounted <code>/data</code> (or{" "}
                <code>LOOPOVER_MINER_CONFIG_DIR</code>) volume
              </td>
            </tr>
            <tr className="align-top">
              <td className="py-2 pr-4 font-medium text-foreground">Setup</td>
              <td className="py-2 pr-4 text-muted-foreground">
                <code>npm install -g @loopover/miner</code> or workspace build
              </td>
              <td className="py-2 text-muted-foreground">
                <code>docker build</code> + <code>docker run</code> with env + volume (see below)
              </td>
            </tr>
            <tr className="align-top">
              <td className="py-2 pr-4 font-medium text-foreground">Footprint</td>
              <td className="py-2 pr-4 text-muted-foreground">
                One Node process, local disk for ledgers/queues
              </td>
              <td className="py-2 text-muted-foreground">
                One container per worker; scale horizontally by adding containers
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Coding-agent provider configuration</h2>
      <p>
        For provider selection and the CLI-specific model/timeout overrides, see{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/README.md">
          <code>README.md</code>
        </a>{" "}
        and the interface-level contract in{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docs/coding-agent-driver.md">
          <code>docs/coding-agent-driver.md</code>
        </a>
        .
      </p>

      <h2>Laptop mode walkthrough</h2>
      <p>1. Install Node.js 22.13+ and the package:</p>
      <CodeBlock
        lang="bash"
        code={`npm install -g @loopover/miner@latest
# or from a checkout:
npm install && npm --workspace @loopover/miner run build`}
      />
      <p>
        2. Inspect what is installed and where local state will live. <code>status</code> and{" "}
        <code>doctor</code> stay offline; <code>init --verify-token</code> is optional and makes one
        authenticated GitHub call up front:
      </p>
      <CodeBlock
        lang="bash"
        code={`loopover-miner status
loopover-miner doctor
loopover-miner init --verify-token   # optional: validate GITHUB_TOKEN once before attempts
loopover-miner init --interactive    # optional: guided prompt for GITHUB_TOKEN + provider, writes a starter .env, then reruns doctor`}
      />
      <p>
        <code>init --interactive</code> offers "Authorize with GitHub" (device flow — visit a URL,
        enter a short code, no token to copy or paste) as its first option once{" "}
        <code>LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID</code> is configured for the centrally-held{" "}
        <code>loopover-ams</code> GitHub App; the original pasted-PAT prompt stays available as
        option 2, and is what the wizard falls back to automatically on any device-flow failure.
        Unconfigured, the wizard is byte-identical to the pasted-token-only prompt. Either way, the
        resulting <code>GITHUB_TOKEN</code> acts as your own GitHub account — there is no separate
        bot identity; see{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/README.md">
          <code>README.md</code>
        </a>{" "}
        for the credential model.
      </p>
      <p>3. Expected layout after first use (default paths):</p>
      <CodeBlock
        lang="text"
        code={`~/.config/loopover-miner/
  laptop-state.sqlite3          # laptop-mode setup state, created by \`init\`
  portfolio-queue.sqlite3       # prioritized work backlog across tracked repos
  claim-ledger.sqlite3          # soft issue claims
  plan-store.sqlite3            # persisted MCP plan DAGs
  run-state.sqlite3             # per-repo run state (idle/discovering/planning/preparing)
  event-ledger.sqlite3          # append-only miner-loop event audit trail
  governor-ledger.sqlite3       # append-only governor allow/deny/throttle decisions
  governor-state.sqlite3        # governor cross-attempt counters/state
  attempt-log.sqlite3           # per-attempt coding-agent driver event trace
  worktree-allocator.sqlite3    # git-worktree-per-attempt allocation bookkeeping
  prediction-ledger.sqlite3     # predicted-gate verdicts, for later self-improve scoring
  replay-snapshot.sqlite3       # frozen historical-replay target snapshots
  policy-doc-cache.sqlite3      # ETag cache for discovery's policy-doc fetches
  policy-verdict-cache.sqlite3  # cache of resolved AI-usage-policy verdicts
  deny-hook-synthesis.sqlite3   # synthesized PreToolUse deny-hook proposals
  orb-export.sqlite3            # opt-in anonymized Orb telemetry export state`}
      />
      <p>
        Not every file appears immediately: <code>laptop-state</code> is written by{" "}
        <code>init</code>, and each of the others is created the first time its subsystem actually
        runs (an attempt, a discovery pass, a replay, an Orb export, …), so a fresh install that has
        only run <code>status</code>/<code>doctor</code> will show a subset. All sixteen default
        into this one directory. Override the directory for every store at once with{" "}
        <code>LOOPOVER_MINER_CONFIG_DIR</code> or <code>XDG_CONFIG_HOME</code> (same resolution
        chain as <code>@loopover/mcp</code>); every store except <code>laptop-state.sqlite3</code>{" "}
        (directory only) also honors its own <code>LOOPOVER_MINER_&lt;NAME&gt;_DB</code> path
        override — e.g. <code>LOOPOVER_MINER_PORTFOLIO_QUEUE_DB</code> — to relocate an individual
        file. <code>doctor</code>'s <code>store-integrity:*</code> checks report the persistent
        stores, so it is the quickest way to confirm what exists and is readable on disk.
      </p>
      <p>
        4. Optional per-repo miner goals: copy{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/.loopover-miner.yml.example">
          <code>.loopover-miner.yml.example</code>
        </a>{" "}
        to a target repo as <code>.loopover-miner.yml</code>. See{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docs/miner-goal-spec.md">
          <code>docs/miner-goal-spec.md</code>
        </a>
        .
      </p>

      <h2>Fleet mode walkthrough</h2>
      <p>
        Build the fleet image from the <strong>monorepo root</strong> (the Dockerfile needs the full
        workspace on disk before <code>npm ci</code> — see comments in{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/Dockerfile">
          <code>Dockerfile</code>
        </a>
        ):
      </p>
      <CodeBlock
        lang="bash"
        code={`docker build -f packages/loopover-miner/Dockerfile -t loopover-miner:latest .`}
      />
      <p>
        Run a disposable worker with persistent SQLite state on a mounted volume. Inject secrets at
        runtime (never bake them into the image):
      </p>
      <CodeBlock
        lang="bash"
        code={`docker run --rm -it \\
  -e LOOPOVER_MINER_CONFIG_DIR=/data/miner \\
  -e GITHUB_TOKEN \\
  -v miner-data:/data/miner \\
  loopover-miner:latest \\
  doctor`}
      />
      <p>
        The image entrypoint is <code>loopover-miner</code>; pass subcommands after the image name (
        <code>status</code>, <code>doctor</code>, <code>claim</code>, …).
      </p>
      <FeatureRow
        items={[
          {
            title: "/data/miner volume",
            description:
              "Holds all SQLite state (claim-ledger.sqlite3, plan-store.sqlite3, etc.) so containers are disposable. Defaults to LOOPOVER_MINER_CONFIG_DIR=/data/miner in the image.",
          },
          {
            title: "GITHUB_TOKEN",
            description: "Supplied by the operator at run time; the image contains no credentials.",
          },
          {
            title: "Scale",
            description:
              "Launch additional containers with the same volume (or partitioned config dirs) for parallel attempts.",
          },
        ]}
      />
      <Callout variant="note" title="Secret-file alternative (GITHUB_TOKEN_FILE)">
        A plain <code>-e GITHUB_TOKEN</code> value is visible in plaintext via{" "}
        <code>docker inspect</code>/<code>docker compose config</code> and any full-env dump of the
        running container. For Docker Swarm/Kubernetes-managed secrets (mounted as a file, e.g. at{" "}
        <code>/run/secrets/github_token</code>), set <code>GITHUB_TOKEN_FILE</code> to that mount
        path instead — the miner reads and trims the file's contents at startup and uses it exactly
        as if <code>GITHUB_TOKEN</code> had been set directly:
        <CodeBlock
          className="mt-3"
          lang="bash"
          code={`docker run --rm -it \\
  -e LOOPOVER_MINER_CONFIG_DIR=/data/miner \\
  -e GITHUB_TOKEN_FILE=/run/secrets/github_token \\
  -v miner-data:/data/miner \\
  -v /path/to/your/secret:/run/secrets/github_token:ro \\
  loopover-miner:latest \\
  doctor`}
        />
      </Callout>
      <p>
        If both <code>GITHUB_TOKEN</code> and <code>GITHUB_TOKEN_FILE</code> are set, the plain{" "}
        <code>GITHUB_TOKEN</code> value always wins (same precedence rule as ORB's own{" "}
        <code>src/selfhost/load-file-secrets.ts</code>). A missing or unreadable{" "}
        <code>GITHUB_TOKEN_FILE</code> fails the container fast with a clear error naming the file
        path, rather than silently proceeding with no credential. The same{" "}
        <code>&lt;NAME&gt;_FILE</code> convention works for any credential the miner reads from a
        plain env var — not only <code>GITHUB_TOKEN</code>.
      </p>
      <p>
        The repo-root{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/docker-compose.yml">
          <code>docker-compose.yml</code>
        </a>{" "}
        documents the <strong>self-hosted review stack</strong> (the <code>loopover</code> API/orb),
        not the miner CLI. Miners are clients of that stack (or of github.com directly) and do not
        require it to run locally.
      </p>

      <h3>Docker Compose (fleet mode)</h3>
      <p>
        Instead of a hand-assembled <code>docker run</code>,{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docker-compose.miner.yml">
          <code>docker-compose.miner.yml</code>
        </a>{" "}
        defines a long-lived <code>miner</code> service (built from this package's Dockerfile,{" "}
        <code>restart: unless-stopped</code>, state on a named <code>miner-data</code> volume).
        Credentials come from an env file, never inlined:
      </p>
      <CodeBlock
        lang="bash"
        code={`cp .loopover-miner.env.example .loopover-miner.env   # fill in GITHUB_TOKEN (+ optional provider keys)
docker compose -f docker-compose.miner.yml up -d --build`}
      />
      <p>
        <strong>Scaling to N parallel workers.</strong>{" "}
        <code>docker compose -f docker-compose.miner.yml up -d --scale miner=N</code> gives every
        replica the <strong>same</strong> <code>miner-data</code> volume — and the miner's SQLite
        ledgers are <strong>not</strong> safe for concurrent access, so N replicas on one volume
        will contend/corrupt. To run N <strong>isolated</strong> workers, give each its own state:
        run N separate compose projects (<code>docker compose -p miner-1 …</code>,{" "}
        <code>-p miner-2 …</code> — <code>-p</code> namespaces the volume) or point each at a
        distinct <code>LOOPOVER_MINER_CONFIG_DIR</code> on its own mount. For built-in isolated
        horizontal scaling, use the Kubernetes StatefulSet in{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/k8s/">
          <code>k8s/</code>
        </a>{" "}
        (per-pod volumes).
      </p>

      <h3>Running fleet mode alongside ORB's ams-observability profile</h3>
      <p>
        Fleet mode keeps miner state in a named <code>miner-data</code> volume, but ORB's{" "}
        <code>ams-reporting-exporter</code> (root{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/docker-compose.yml">
          <code>docker-compose.yml</code>
        </a>
        , <code>--profile ams-observability</code>) reads the miner's ledgers from a{" "}
        <strong>host</strong> directory (default <code>~/.config/loopover-miner</code>). A named
        volume's host path is a Docker-managed internal detail, so the two never line up on their
        own — the exporter reads an empty directory and the Grafana AMS datasources stay{" "}
        <strong>silently empty</strong>.
      </p>
      <p>
        To bridge them, relocate the fleet miner's state onto a host directory with the opt-in
        override, then run both profiles together:
      </p>
      <CodeBlock
        lang="bash"
        code={`cp packages/loopover-miner/docker-compose.miner.override.yml.example \\
   packages/loopover-miner/docker-compose.miner.override.yml   # gitignored; edit the host path only if you want a non-default location

docker compose -f docker-compose.yml \\
  -f packages/loopover-miner/docker-compose.miner.yml \\
  -f packages/loopover-miner/docker-compose.miner.override.yml \\
  --profile ams-observability up -d`}
      />
      <Callout variant="note">
        The override bind-mounts <code>/data/miner</code> to{" "}
        <code>{"${LOOPOVER_MINER_CONFIG_DIR:-~/.config/loopover-miner}"}</code> — the{" "}
        <strong>same</strong> variable and default the exporter already uses — so both read one
        location with no <code>docker volume inspect</code> archaeology. Leave both unset for the
        default, or set <code>LOOPOVER_MINER_CONFIG_DIR</code> once and both the fleet miner and the
        exporter follow it. This override is opt-in and additive: without it,{" "}
        <code>docker-compose.miner.yml</code>'s named-volume default is unchanged.
      </Callout>

      <h2>Bare-host (systemd, no Docker)</h2>
      <p>
        To run the miner continuously on a plain Linux host without Docker, supervise{" "}
        <code>loopover-miner loop</code> — the autonomous discover → attempt → manage daemon — with
        systemd.{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/systemd/loopover-miner.service.example">
          <code>systemd/loopover-miner.service.example</code>
        </a>{" "}
        is a ready-to-adapt persistent unit; its header carries the full install steps:
      </p>
      <CodeBlock
        lang="bash"
        code={`npm install -g @loopover/miner
loopover-miner init --verify-token   # optional: validate GITHUB_TOKEN before discovery/attempt runs
sudo cp systemd/loopover-miner.service.example /etc/systemd/system/loopover-miner.service
sudo $EDITOR /etc/systemd/system/loopover-miner.service   # set User / WorkingDirectory / ExecStart / secrets
sudo systemctl daemon-reload
sudo systemctl enable --now loopover-miner.service`}
      />
      <p>
        Because <code>loop</code> is a{" "}
        <strong>long-running daemon that schedules its own cycles</strong>, it is a persistent{" "}
        <code>Type=simple</code> service (with <code>Restart=on-failure</code>) —{" "}
        <strong>not</strong> a oneshot unit driven by a <code>.timer</code>, unlike the periodic{" "}
        <code>loopover-docker-prune.*.example</code> hygiene job in{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/systemd/">
          <code>systemd/</code>
        </a>
        . Keep <code>GITHUB_TOKEN</code> (and any coding-agent credentials) in a root-owned{" "}
        <code>0600</code> <code>EnvironmentFile</code>, never in the unit file. Follow the loop with{" "}
        <code>journalctl -u loopover-miner -f</code>; <code>systemctl stop</code> sends SIGTERM,
        which the loop handles cleanly at its next kill-switch check.
      </p>
      <p>
        Want the dashboard too?{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/systemd/loopover-miner-ui.service.example">
          <code>systemd/loopover-miner-ui.service.example</code>
        </a>{" "}
        is a companion unit that serves <code>apps/loopover-miner-ui</code> persistently over the
        same local state — see that app's{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/apps/loopover-miner-ui/README.md#running-as-a-persistent-service">
          README
        </a>
        .
      </p>

      <h2>Invariants</h2>
      <ul>
        <li>
          Core miner bookkeeping (claims, plans, queues, ledgers) works offline after install.
        </li>
        <li>
          <code>loopover-miner status</code> and <code>loopover-miner doctor</code> make{" "}
          <strong>no network calls</strong>.
        </li>
        <li>
          Discovery/ranking primitives that touch GitHub only run when explicitly invoked and only
          perform documented GETs unless a future command says otherwise.
        </li>
        <li>Operators own secret injection; images and packages ship without embedded tokens.</li>
      </ul>
      <p>
        See{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docs/operations-runbook.md">
          <code>docs/operations-runbook.md</code>
        </a>{" "}
        for operational scenarios: ledger corruption, two miners on one state dir, and post-upgrade
        schema migration.
      </p>
      <p>
        See{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docs/sizing.md">
          <code>docs/sizing.md</code>
        </a>{" "}
        for measured CPU/RAM/disk numbers for laptop mode vs. fleet mode at different worker counts,
        with the exact commands used to reproduce them.
      </p>

      <h2>Optional hosted discovery plane (opt-in)</h2>
      <p>
        The hosted discovery-index is <strong>off by default</strong> — unlike Orb fleet export (
        <code>ORB_AIR_GAP</code> is the only opt-out). Operators who want cross-fleet metadata
        queries or soft-claim coordination must opt in explicitly. See{" "}
        <a href="https://github.com/JSONbored/loopover/blob/main/packages/loopover-miner/docs/discovery-plane-operator-guide.md">
          <code>docs/discovery-plane-operator-guide.md</code>
        </a>
        .
      </p>
      <p>
        For the day-one boot path (env, health checks, GitHub App), see{" "}
        <Link to="/docs/self-hosting-quickstart">Self-hosting quickstart</Link>.
      </p>
    </DocsPage>
  );
}
