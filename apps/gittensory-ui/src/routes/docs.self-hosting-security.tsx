import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-security")({
  head: () => ({
    meta: [
      { title: "Self-host security — Gittensory docs" },
      {
        name: "description",
        content:
          "Secure the self-hosted Gittensory review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:title", content: "Self-host security — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Secure the self-hosted Gittensory review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
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

      <h2>Private policy</h2>
      <p>
        Keep sensitive review thresholds, autonomy, maintainer notes, and repo-specific rules in
        <code>GITTENSORY_REPO_CONFIG_DIR</code>, not in public repo config.
      </p>
      <CodeBlock filename=".env" code={`GITTENSORY_REPO_CONFIG_DIR=/config`} />

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
          (<code>127.0.0.1:3000:3000</code> in a compose override) or put it behind the Caddy or
          Tailscale profile described below before running the <code>observability</code> profile
          anywhere it isn't already firewalled.
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
              "A private-network sidecar — no public port at all, but also not reachable by GitHub's own webhook delivery. Use this for team/CI-only access, or alongside brokered pull mode.",
          },
          {
            title: "Bring your own reverse proxy",
            description:
              "Skip both profiles and put an existing nginx/Traefik/ALB in front of the gittensory service's own port instead.",
          },
        ]}
      />

      <h3>Caddy: automatic HTTPS with Let's Encrypt</h3>
      <p>
        The <code>caddy</code> profile runs Caddy 2 in front of the <code>gittensory</code> service,
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
        The shipped <code>caddy/Caddyfile</code> reverse-proxies to <code>gittensory:8787</code> on
        the compose network, forwards the real client IP, enables compression, sets standard
        security headers (HSTS, <code>X-Content-Type-Options</code>, <code>X-Frame-Options</code>, a
        strict referrer policy), and logs as JSON to stderr:
      </p>
      <CodeBlock
        filename="caddy/Caddyfile"
        code={`{$DOMAIN} {
	reverse_proxy gittensory:8787 {
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
        The <code>gittensory</code> service's compose entry has a direct{" "}
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
        mapping from the <code>gittensory</code> service, keep it on the compose network (or publish{" "}
        <code>8787</code> bound to a private interface your existing proxy can reach), and terminate
        TLS the way you already do for everything else — nginx, Traefik, an AWS ALB, a Cloudflare
        Tunnel. Whatever fronts it just needs to forward to port <code>8787</code> and preserve the
        client IP the same way the shipped Caddyfile does.
      </p>

      <h3>Tailscale: private-network access, no public port</h3>
      <p>
        The <code>tailscale</code> profile joins the stack to your tailnet instead of exposing
        anything to the public internet. It runs with <code>network_mode: host</code> — Tailscale
        needs host networking to advertise this machine's address on the tailnet.
      </p>
      <CodeBlock
        filename=".env"
        code={`TS_AUTHKEY=            # generate at tailscale.com/admin/settings/keys
TS_EXTRA_ARGS=          # optional, e.g. --advertise-tags=tag:self-host`}
      />
      <Callout variant="warn" title="Unlike Caddy, keep the app's port mapping">
        Tailscale doesn't replace the <code>gittensory</code> service's listener the way Caddy does
        — it adds a new network interface to the <em>host</em>. Docker's default{" "}
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
