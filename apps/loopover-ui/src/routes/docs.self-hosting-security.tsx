import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-security")({
  head: () => ({
    meta: [
      { title: "Self-host security — LoopOver docs" },
      {
        name: "description",
        content:
          "Secure the self-hosted LoopOver review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:title", content: "Self-host security — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Secure the self-hosted LoopOver review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:url", content: "/docs/self-hosting-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-security" }],
  }),
  component: SelfHostingSecurity,
});

function SelfHostingSecurity() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Security"
      description="The self-host stack holds maintainer credentials and policy. Keep those boundaries explicit."
    >
      <h2>Secret handling</h2>
      <FeatureRow
        items={[
          {
            title: "Never bake secrets",
            description:
              "Images should not contain .env files, private keys, API keys, webhook secrets, REES secrets, or CLI auth files.",
          },
          {
            title: "Prefer secret files",
            description:
              "Use FOO_FILE for multiline values and orchestrator-managed secrets where possible.",
          },
          {
            title: "Rotate deliberately",
            description:
              "Rotate GitHub webhook secrets, API tokens, REES secrets, and provider keys with a restart window and validation PR.",
          },
        ]}
      />
      <p>
        <code>docker-compose.yml</code> ships native Docker Compose <code>secrets:</code> mounts for
        the highest-value secrets (the GitHub App private key, webhook secret, API/MCP/internal-job
        tokens, the setup token, the two token-encryption master keys, the Orb enrollment secret,
        the PagerDuty routing key, and the Claude Code subscription token) — file-mounted at{" "}
        <code>/run/secrets/&lt;name&gt;</code>, never exposed via <code>docker inspect</code> or{" "}
        <code>docker compose config</code> the way a plain <code>environment:</code>/
        <code>env_file</code> value is. This is purely additive: an inline <code>.env</code> value
        always takes priority if you set both, so you can migrate one secret at a time, or not at
        all. See <code>secrets/README.md</code> for the full file list.
      </p>
      <CodeBlock
        filename="shell"
        code={`./scripts/selfhost-init-secrets.sh   # creates empty placeholder files (idempotent)
printf '%s' 'your-real-secret-value' > secrets/github_webhook_secret.txt
docker compose up -d --no-deps loopover`}
      />

      <h2>Optional: Infisical secrets management</h2>
      <p>
        The hardened default above — <code>.env</code> plus Docker Compose <code>secrets:</code> —
        has no rotation, audit trail, or RBAC. If you want secrets-manager-grade rotation, audit
        logging, and access control on top of that default, you can opt into{" "}
        <a href="https://infisical.com" target="_blank" rel="noreferrer">
          Infisical
        </a>{" "}
        — an open-source, self-hostable secrets manager. This is{" "}
        <strong>strictly optional and additive</strong>: skip this section entirely and the hardened{" "}
        <code>.env</code>/Docker secrets default keeps working unchanged.
      </p>
      <Callout variant="note" title="No application code changes">
        Infisical wires in at the deploy-script level via its own{" "}
        <code>infisical run -- &lt;command&gt;</code> wrapper, which injects secrets as real process
        environment variables at container launch. Nothing under <code>src/</code> knows or cares
        whether a given <code>env.SOMETHING</code> value came from Infisical, <code>.env</code>, or
        a Docker secret file.
      </Callout>

      <h3>Setup: cloud or self-hosted</h3>
      <ol>
        <li>
          Install the{" "}
          <a href="https://infisical.com/docs/cli/overview" target="_blank" rel="noreferrer">
            Infisical CLI
          </a>{" "}
          on the machine that runs the deploy script (not inside the app container).
        </li>
        <li>
          Pick where your secrets live: Infisical Cloud (the default, zero infrastructure of your
          own) or a self-hosted Infisical instance — if you're already self-hosting LoopOver, you
          can self-host Infisical alongside it. Either way, run <code>infisical login</code> once,
          then <code>infisical init</code> from the repo root to link a local{" "}
          <code>.infisical.json</code> to an Infisical project.
        </li>
        <li>
          Create an environment inside that project (e.g. <code>prod</code>) matching how you think
          about this deployment, and add the secrets you want Infisical to manage — same variable
          names your <code>.env</code>/<code>docker-compose.yml</code> already use (
          <code>GITHUB_APP_PRIVATE_KEY</code>, <code>GITHUB_WEBHOOK_SECRET</code>, provider API
          keys, and so on).
        </li>
        <li>Opt in when deploying:</li>
      </ol>
      <CodeBlock
        filename="shell"
        code={`SELFHOST_USE_INFISICAL=1 ./scripts/deploy-selfhost-image.sh
# or
SELFHOST_USE_INFISICAL=1 ./scripts/deploy-selfhost-prebuilt.sh`}
      />
      <p>
        With the flag unset (the default), neither script touches Infisical at all — not even a
        presence check — so an operator who has never heard of Infisical is completely unaffected.
        With it set, the restart step (the one that actually launches the container) runs through{" "}
        <code>infisical run --</code>; a missing <code>infisical</code> binary fails the deploy
        immediately with a clear error rather than silently deploying without the secrets you asked
        for.
      </p>

      <h3>Interaction with .env and Docker secrets — do not mix the same variable</h3>
      <Callout
        variant="warn"
        title="Infisical only reaches variables interpolated in docker-compose.yml"
      >
        <code>infisical run --</code> injects secrets into its own child process's environment — in
        this case, the <code>docker compose up</code> invocation. Docker Compose only lets a host
        shell variable reach the container for an <code>environment:</code> entry written as{" "}
        <code>{`SOMEVAR: "\${SOMEVAR}"`}</code>. It does <strong>not</strong> reach a plain{" "}
        <code>env_file: .env</code> block, which reads that file's literal contents at container
        runtime and is never affected by the deploying shell's environment. The GitHub App private
        key, webhook secret, API/MCP tokens, and the rest of the native-secrets list above are wired
        through the <code>_FILE</code> convention and <code>env_file: .env</code>, not through{" "}
        <code>environment:</code> interpolation — an Infisical value for one of those exact names,
        by itself, will <strong>not</strong> reach the container today. Infisical is the right fit
        for <em>other</em> variables you reference via <code>{`"\${VAR}"`}</code> interpolation in
        your own <code>docker-compose.override.yml</code> (a provider API key you add yourself, for
        example) — not a drop-in override for the pre-wired native-secrets list.
      </Callout>
      <p>
        The safest rule of thumb: for any given variable, pick <em>one</em> source — Infisical or a
        plain <code>.env</code>/Docker secret file, never both for the same name. Setting the same
        name in both places doesn't error; whichever mechanism the container actually reads for that
        variable (see the callout above) wins silently, which is easy to misdiagnose later.
      </p>

      <h2>Private policy</h2>
      <p>
        Keep sensitive review thresholds, autonomy, maintainer notes, and repo-specific rules in
        <code>LOOPOVER_REPO_CONFIG_DIR</code>, not in public repo config.
      </p>
      <CodeBlock filename=".env" code={`LOOPOVER_REPO_CONFIG_DIR=/config`} />

      <h2>Network exposure</h2>
      <ul>
        <li>
          Expose the webhook endpoint only through TLS — see "TLS termination" below for the two
          shipped ways to get there.
        </li>
        <li>
          Prometheus, Qdrant, Ollama, and the database ports are private by default (bound to{" "}
          <code>127.0.0.1</code> or only reachable on the compose network) — but{" "}
          <strong>Grafana is the exception</strong>. Its compose entry publishes{" "}
          <code>3000:3000</code>, which binds every interface, not just localhost. Bind it yourself
          (<code>127.0.0.1:3000:3000</code> in a compose override) — the reliable fix — before
          running the <code>observability</code> profile anywhere it isn't already firewalled.
          Running Tailscale alongside it does <strong>not</strong> narrow this on its own (see "TLS
          termination" below); combining the two safely still needs the same firewall or{" "}
          <code>tailscale serve</code> step.
        </li>
        <li>Put an auth layer in front of dashboards and internal admin routes.</li>
        <li>
          Use <code>/ready</code> for orchestrators, not as a public status surface.
        </li>
      </ul>
      <p>
        The <code>observability</code> profile also runs a <code>docker-proxy</code> service that
        never appears in any dashboard or metric. It fronts the Docker socket for Promtail's
        container log discovery: a plain <code>:ro</code> bind-mount of{" "}
        <code>/var/run/docker.sock</code> only protects the socket inode, not the Docker API behind
        it, so handing Promtail the raw socket is effectively host root — enumerate every container,
        read each one's environment and secrets, tail every log, or start a privileged container and
        escape to the host. <code>docker-proxy</code> is the only container that touches the socket,
        exposes just the read-only <code>/containers/*</code> and <code>/networks/*</code> endpoints
        Promtail's service discovery needs, denies every mutating call outright, and sits alone on
        its own Docker network shared only with Promtail — publishing no host port isn't enough on
        its own, since the default compose network is reachable by every other service in the stack.
      </p>

      <h2>Control-panel access</h2>
      <p>
        GitHub sign-in to the control panel (the maintainer/owner dashboard) is gated by{" "}
        <code>ADMIN_GITHUB_LOGINS</code> — a comma- or whitespace-separated, case-insensitive
        allowlist of GitHub logins.
      </p>
      <CodeBlock
        filename=".env"
        code={`ADMIN_GITHUB_LOGINS=your-github-login,a-second-maintainer`}
      />
      <Callout variant="warn" title="Fail-closed by design">
        Unset or empty means NOBODY gets control-panel access — not even the person who just
        finished setup. This is intentional, not a bug: add your own GitHub login here right after
        first-run setup, or you will sign in successfully and see zero privileges with no
        explanation. The same allowlist also exempts these logins from the agent's own-PR auto-close
        rules and lets them bypass per-repo MCP scope (<code>MCP_READ_REPO_ALLOWLIST</code> /{" "}
        <code>MCP_ACTUATION_REPO_ALLOWLIST</code>).
      </Callout>

      <h2>AI credential boundaries</h2>
      <Callout variant="warn" title="Subscription CLI credentials">
        CLI auth files can be readable by the runtime. Do not mount a prompt-readable Claude Code or
        Codex home into review execution unless you have intentionally isolated it. API-key and
        local model providers are easier to reason about operationally.
      </Callout>

      <h2>REES boundary</h2>
      <p>
        REES receives PR diff and file metadata. Use a private network URL when possible, require
        <code>REES_SHARED_SECRET</code>, and remember that the engine treats REES output as
        untrusted advisory context.
      </p>

      <h2>TLS termination</h2>
      <p>
        These are the three shipped ways to get real HTTPS without hand-rolling a reverse proxy —
        but only Caddy and bring-your-own-proxy give you a <em>publicly reachable</em> origin. If
        GitHub itself needs to reach this instance (a direct App in push mode, per{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>), Tailscale's private
        tailnet address does not satisfy that — GitHub's servers can't reach it. Tailscale is the
        right fit when only your own team/CI needs access, or as the transport for a{" "}
        <Link to="/docs/self-hosting-github-app">brokered, pull-mode</Link> instance that never
        needs to receive an inbound webhook at all.
      </p>
      <FeatureRow
        items={[
          {
            title: "Caddy (--profile caddy)",
            description:
              "A public HTTPS terminator with automatic Let's Encrypt certificates. Required for a direct App in push mode; use this when the instance needs a real internet-facing domain.",
          },
          {
            title: "Tailscale (--profile tailscale)",
            description:
              "Adds private tailnet reachability, but with the default port mapping left in place (required — see below), the app stays reachable on every host interface too, not just the tailnet; firewall the host or use tailscale serve for real no-public-port isolation. Also not reachable by GitHub's own webhook delivery — use this for team/CI-only access, or alongside brokered pull mode.",
          },
          {
            title: "Bring your own reverse proxy",
            description:
              "Skip both profiles and put an existing nginx/Traefik/ALB in front of the loopover service's own port instead.",
          },
        ]}
      />

      <h3>Caddy: automatic HTTPS with Let's Encrypt</h3>
      <p>
        The <code>caddy</code> profile runs Caddy 2 in front of the <code>loopover</code> service,
        terminating TLS on <code>80</code>/<code>443</code>/<code>443/udp</code> (the last for
        HTTP/3) and obtaining a Let's Encrypt certificate automatically for whatever domain you set.
        It needs a real DNS record: point <code>DOMAIN</code> at this host's public IP{" "}
        <em>before</em> starting the profile. The shipped Caddyfile has no fallback TLS directive,
        so if the ACME HTTP-01 challenge fails (DNS not propagated yet, port 80 unreachable), Caddy
        does <strong>not</strong> silently substitute a self-signed cert for a real domain — it logs
        the failure and retries with backoff, and the site has no working HTTPS until DNS and ACME
        both succeed. (A recognized non-public hostname like <code>localhost</code>, below, is a
        deliberately different case — Caddy issues its own internal-CA cert for those automatically,
        since it can never get a real one.)
      </p>
      <CodeBlock filename=".env" code={`DOMAIN=reviews.yourcompany.com`} />
      <p>
        The shipped <code>caddy/Caddyfile</code> reverse-proxies to <code>loopover:8787</code> on
        the compose network, forwards the real client IP, enables compression, sets standard
        security headers (HSTS, <code>X-Content-Type-Options</code>, <code>X-Frame-Options</code>, a
        strict referrer policy), and logs as JSON to stderr:
      </p>
      <CodeBlock
        filename="caddy/Caddyfile"
        code={`{$DOMAIN} {
	reverse_proxy loopover:8787 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}

	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	log {
		output stderr
		format json
	}
}`}
      />
      <p>
        Edit this file directly if you need a different upstream, extra headers, or a second site
        block — Caddy re-reads it on container restart. For local testing without a real domain, set{" "}
        <code>DOMAIN=localhost</code>; Caddy issues a self-signed cert and your browser will warn
        about it, which is expected.
      </p>
      <Callout variant="warn" title="Remove the app's own port mapping">
        The <code>loopover</code> service's compose entry has a direct{" "}
        <code>{`ports: ["\${PORT:-8787}:8787"]`}</code> mapping with a comment marking exactly this:
        remove it once Caddy is your public listener, or the app stays reachable on{" "}
        <code>:8787</code> with no TLS, bypassing the proxy entirely and defeating the whole point
        of adding it. (This rule is Caddy-specific — the Tailscale profile below needs the{" "}
        <em>opposite</em> treatment; see its own callout.)
      </Callout>
      <p>
        Prefer certificates you already manage — an internal CA, a wildcard cert issued elsewhere —
        instead of Let's Encrypt? Mount your own cert and key into the container and point the{" "}
        <code>{`{$DOMAIN}`}</code> block at a file-based TLS directive (
        <code>tls /path/to/cert /path/to/key</code>) instead of the automatic-HTTPS default; see{" "}
        <a
          href="https://caddyserver.com/docs/caddyfile/directives/tls"
          target="_blank"
          rel="noreferrer"
        >
          Caddy's <code>tls</code> directive docs
        </a>{" "}
        for the syntax.
      </p>

      <h3>Already run a reverse proxy or load balancer?</h3>
      <p>
        Skip the <code>caddy</code> profile entirely. Remove the same direct <code>ports:</code>{" "}
        mapping from the <code>loopover</code> service, keep it on the compose network (or publish{" "}
        <code>8787</code> bound to a private interface your existing proxy can reach), and terminate
        TLS the way you already do for everything else — nginx, Traefik, an AWS ALB, a Cloudflare
        Tunnel. Whatever fronts it just needs to forward to port <code>8787</code> and preserve the
        client IP the same way the shipped Caddyfile does.
      </p>

      <h3>Tailscale: adds tailnet reachability</h3>
      <p>
        The <code>tailscale</code> profile joins the stack to your tailnet. It runs with{" "}
        <code>network_mode: host</code> — Tailscale needs host networking to advertise this
        machine's address on the tailnet. On its own, this only <em>adds</em> a reachable address;
        see the callout below before assuming it also removes public reachability.
      </p>
      <CodeBlock
        filename=".env"
        code={`TS_AUTHKEY=            # generate at tailscale.com/admin/settings/keys
TS_EXTRA_ARGS=          # optional, e.g. --advertise-tags=tag:self-host`}
      />
      <Callout variant="warn" title="Unlike Caddy, keep the app's port mapping">
        Tailscale doesn't replace the <code>loopover</code> service's listener the way Caddy does —
        it adds a new network interface to the <em>host</em>. Docker's default{" "}
        <code>{`ports: ["\${PORT:-8787}:8787"]`}</code> mapping publishes to all of the host's
        interfaces, so once Tailscale is up, that same mapping is what makes port <code>8787</code>{" "}
        reachable at the host's tailnet IP too —{" "}
        <strong>
          removing it, as you would for Caddy, makes the app unreachable everywhere, tailnet
          included.
        </strong>
      </Callout>
      <p>
        The tradeoff: leaving the default <code>0.0.0.0</code>-bound mapping in place means{" "}
        <code>8787</code> is also still reachable from your LAN, and from the public internet if
        this host has a public interface at all — Tailscale doesn't narrow that on its own. If you
        want the instance reachable <em>only</em> via the tailnet, either firewall the host to allow{" "}
        <code>8787</code> solely from your tailnet's address range, or bind the app's mapping to{" "}
        <code>127.0.0.1:8787:8787</code> and use{" "}
        <a href="https://tailscale.com/kb/1242/tailscale-serve" target="_blank" rel="noreferrer">
          <code>tailscale serve</code>
        </a>{" "}
        inside the <code>tailscale</code> container (it shares the host's loopback under{" "}
        <code>network_mode: host</code>) to proxy that localhost-only port onto the tailnet — check
        the pinned image's <code>tailscale serve --help</code> for the exact current flags. This
        profile is the right choice when the instance only needs to be reachable by your own team or
        CI, and you'd rather not manage a domain or certificate at all.
      </p>

      <h2>Public output boundary</h2>
      <p>
        Public PR comments and checks must not leak secrets, private policy, provider credentials,
        private scoring context, or maintainer-only notes. For hosted and self-host boundaries, keep
        <Link to="/docs/privacy-security"> Privacy and security</Link> nearby.
      </p>
    </DocsPage>
  );
}
