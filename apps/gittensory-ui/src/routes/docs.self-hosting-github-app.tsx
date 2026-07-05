import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-github-app")({
  head: () => ({
    meta: [
      { title: "Self-host GitHub App and Orb — Gittensory docs" },
      {
        name: "description",
        content:
          "Connect a self-hosted Gittensory review service to GitHub with your own direct GitHub App (the default, recommended path) or private managed-beta brokered Orb enrollment.",
      },
      { property: "og:title", content: "Self-host GitHub App and Orb — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Connect a self-hosted Gittensory review service to GitHub with your own direct GitHub App (the default, recommended path) or private managed-beta brokered Orb enrollment.",
      },
      { property: "og:url", content: "/docs/self-hosting-github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-github-app" }],
  }),
  component: SelfHostingGithubApp,
});

function SelfHostingGithubApp() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="GitHub App and Orb"
      description="A self-host needs webhook delivery and installation tokens. Direct GitHub App is the default, recommended model — Orb broker mode is private/managed-beta only."
    >
      <h2>Choose a connection mode</h2>
      <FeatureRow
        items={[
          {
            title: "Direct GitHub App (recommended default)",
            description:
              "Your self-host stores its own App id, slug, private key, and webhook secret, and mints installation tokens directly. No shared quota, no dependency on gittensory's own infrastructure to process a review.",
          },
          {
            title: "Brokered Orb (private/managed-beta only)",
            description:
              "Your self-host uses ORB_ENROLLMENT_SECRET to request short-lived installation tokens from the central Orb broker instead of holding its own App key. Not open for general public use — see the operational risks below before considering it.",
          },
        ]}
      />
      <Callout variant="safety">
        Direct App mode is the public default: it costs gittensory nothing to support and can't
        overrun a shared rate-limit budget. Brokered mode routes every token mint through
        gittensory's own infrastructure and GitHub API quota — every external brokered install is
        gittensory's rate-limit and reliability problem, not just the operator's, so it stays
        private/managed-beta until the safeguards below are in place.
      </Callout>

      <h2>One-click App creation (recommended for a Direct App)</h2>
      <p>
        Before the App exists (no <code>GITHUB_APP_ID</code> set yet), the self-host serves a setup
        wizard at <code>GET /setup</code>. It renders a form that POSTs a GitHub App{" "}
        <em>manifest</em> — the exact permission and event set below, pre-filled — to GitHub's own
        App-creation flow. GitHub creates the App with the correct configuration in one step and
        redirects back to exchange credentials automatically; there is no manual permission
        checklist to get right or wrong. The route is disabled once an App is configured, so it
        can't rebind a live install.
      </p>
      <CodeBlock
        filename=".env"
        code={`PUBLIC_API_ORIGIN=https://reviews.example.com  # exact public URL, embedded in the manifest
SELFHOST_SETUP_TOKEN=change-this-long-random-value  # unlocks /setup for a freshly-booted instance`}
      />
      <CodeBlock lang="bash" code={`open "https://reviews.example.com/setup"`} />
      <p>
        Enter <code>SELFHOST_SETUP_TOKEN</code> in the browser form. For scripted setup checks, send
        the token in an <code>x-setup-token</code> header or <code>Authorization: Bearer</code>
        header instead; never place the setup token in the URL.
      </p>
      <Callout variant="note">
        <code>https://reviews.example.com</code> above is a placeholder — it assumes you already
        have a real domain terminating TLS. GitHub delivers webhooks to whatever{" "}
        <code>PUBLIC_API_ORIGIN</code> you set here, so it must be an address GitHub's servers can
        actually reach: the <code>caddy</code> profile (see{" "}
        <Link to="/docs/self-hosting-security">Security</Link>'s TLS termination section) is the
        shipped way to get one, or bring your own public reverse proxy. The <code>tailscale</code>{" "}
        profile's private tailnet address does <strong>not</strong> work here — GitHub cannot
        deliver webhooks to it. A Tailscale-only instance should use brokered pull mode instead (it
        polls for work rather than receiving pushed webhooks) — see "Pull vs. push relay mode"
        below.
      </Callout>
      <Callout variant="note">
        Manual App creation (below) is still fully supported — for an air-gapped instance, a
        stricter change-review process, or simply a preference for reviewing every permission by
        hand before it exists. Whichever path you take, the resulting App needs the SAME
        permissions: this doc's manual list is kept in sync with the wizard's manifest and checked
        in CI, so the two can't silently drift apart.
      </Callout>

      <h2>Direct App permissions</h2>
      <ul>
        <li>Pull requests: write.</li>
        <li>
          Checks: write — the gate posts a check-run; <code>checks: read</code> alone 403s that
          write (silently fails the first review with no obvious cause).
        </li>
        <li>Issues: write.</li>
        <li>
          Contents: write — required for BOTH merging and the auto-maintain{" "}
          <code>update_branch</code> action. <code>contents: read</code> looks sufficient at
          creation time but silently breaks auto-merge later with no error surfaced in the UI; there
          is no lesser permission that keeps merge/update-branch working.
        </li>
        <li>Commit statuses: read.</li>
        <li>Metadata: read.</li>
        <li>
          Actions: write — lets a repo opt into cancelling a closed PR's in-flight CI runs (the{" "}
          <code>contributorCapCancelCi</code> setting). Off by default and never required: a repo
          that doesn't enable it, or an installation that hasn't re-approved this permission on an
          existing App, sees no behavior change — the cancellation attempt is skipped and logged,
          never blocking the close itself.
        </li>
      </ul>
      <p>
        Events: pull request, pull request review, push, issues, check suite, check run, and status.
      </p>

      <h2>Re-approving a permission bump on an existing App</h2>
      <p>
        A future release can widen this permission list (most recently, Actions: write for the
        opt-in CI-cancellation feature). GitHub does <strong>not</strong> silently grant a new
        permission to an App that's already installed — the operator who owns the App must
        explicitly re-approve it, the same one-time consent step as the original install.
      </p>
      <p>
        Until you re-approve, the self-host keeps working exactly as before: any feature that needs
        the new permission degrades gracefully (skipped and logged, never a hard failure) rather
        than erroring. There's no forced upgrade window.
      </p>
      <p>To re-approve:</p>
      <ol>
        <li>
          Open your App's settings page —{" "}
          <code>https://github.com/settings/apps/&lt;your-app-slug&gt;/permissions</code>{" "}
          (organization Apps:{" "}
          <code>
            https://github.com/organizations/&lt;org&gt;/settings/apps/&lt;your-app-slug&gt;/permissions
          </code>
          ).
        </li>
        <li>
          GitHub shows a diff between the App's currently-granted permissions and what the App
          manifest now requests. Review it, then save — GitHub sends the installation owner a
          request to accept the new grant.
        </li>
        <li>
          Accept the request (as the installation owner, on each installed org/account). The new
          permission takes effect immediately; no App reinstall or webhook resubscription needed.
        </li>
      </ol>

      <h2>Direct App env</h2>
      <CodeBlock
        filename=".env"
        code={`GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-gittensory-app
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=<same-secret-configured-on-the-app>`}
      />

      <h2>Telemetry is separate from token brokerage</h2>
      <p>
        These are two independent things people conflate because they're both "Orb": anonymized
        fleet-calibration <strong>telemetry export</strong> (enabled by default, works in either
        connection mode) and <strong>token brokerage</strong> (optional, private/managed-beta only,
        lets your self-host get installation tokens from gittensory instead of holding its own App
        key). Choosing Direct App mode does not opt you out of telemetry, and it's what makes{" "}
        <Link to="/">the homepage counters</Link> and cross-fleet gate calibration reflect direct
        installs, not just brokered ones.
      </p>
      <FeatureRow
        items={[
          {
            title: "What's exported",
            description:
              "Per resolved PR: the gate verdict, the realized outcome (merged/closed), a reversal flag, a bucketed reason category, and cycle time.",
          },
          {
            title: "What's never exported",
            description:
              "Repo/owner/PR names, commit SHAs, source code, diffs, comments, or logins. Repo/PR identifiers are HMAC-anonymized by default with a per-instance secret gittensory's own collector never holds.",
          },
          {
            title: "Disabling it",
            description:
              "Set ORB_AIR_GAP=true to compute everything locally and send nothing — the only supported opt-out. There is no partial opt-out short of air-gapping.",
          },
        ]}
      />
      <Callout variant="warn" title="ORB_ANONYMIZE">
        Repo/PR identifiers are HMAC-anonymized by <strong>default</strong> (
        <code>ORB_ANONYMIZE=true</code>), not unconditionally — an operator can set{" "}
        <code>ORB_ANONYMIZE=false</code> to export raw repo/PR names instead. There's no scenario
        where gittensory's own hosted collector needs raw names; the toggle exists for an operator
        running their <strong>own</strong> collector (see <code>ORB_COLLECTOR_URL</code> below) who
        wants readable identifiers in their own infrastructure. Leave this at the default unless you
        control the collector end.
      </Callout>
      <p>
        <code>ORB_COLLECTOR_URL</code> overrides the export endpoint — default gittensory's hosted
        collector, or point it at your own private collector if you're aggregating telemetry
        yourself instead of sending it to gittensory. <code>ORB_COLLECTOR_TOKEN</code> is the bearer
        credential for that private collector; leave it unset when using gittensory's own hosted
        collector, which accepts unauthenticated, rate-limited, aggregate-only exports.
      </p>

      <h2>Brokered Orb env</h2>
      <CodeBlock
        filename=".env"
        code={`ORB_ENROLLMENT_SECRET=<issued-once-by-orb>
ORB_BROKER_URL=https://gittensory-api.aethereal.dev
ORB_RELAY_MODE=pull  # or omit for push (the default) -- see "Choosing a relay mode" below`}
      />
      <p>
        <code>ORB_APP_ID</code> overrides the seed used to derive this instance&apos;s stable,
        anonymous <code>instance_id</code> in telemetry exports — normally derived from{" "}
        <code>GITHUB_APP_ID</code>. A brokered instance holds no App ID of its own (it uses the
        broker&apos;s tokens instead), so its identity falls back to the export secret unless you
        set <code>ORB_APP_ID</code> explicitly. Most operators never need to set this; it exists so
        a brokered instance's telemetry identity can be pinned independent of any App ID.
      </p>

      <h2>Choosing a relay mode: pull vs. push</h2>
      <p>
        Brokered mode still needs a way for GitHub webhook events to reach your self-host through
        the broker. <code>ORB_RELAY_MODE</code> picks how:
      </p>
      <FeatureRow
        items={[
          {
            title: "pull (recommended for NAT/tailnet — no public ingress needed)",
            description:
              "The container polls the broker outbound on a short interval and drains queued events -- no inbound endpoint is ever exposed, and PUBLIC_API_ORIGIN is not required. A failed registration attempt is non-fatal (logged as a warning, not an error): the drain loop keeps retrying on its own schedule and events still arrive once it succeeds.",
          },
          {
            title: "push (the default — requires a stable public origin)",
            description:
              "The broker calls your self-host directly at PUBLIC_API_ORIGIN, which must be a real, internet-reachable, TLS-terminated URL -- the broker validates it server-side at registration time and rejects a loopback or private address outright. A failed registration is fatal: the container looks healthy but never receives an event, since there's no fallback delivery path.",
          },
        ]}
      />
      <Callout variant="note">
        If you're not behind a stable public ingress — a home connection, a NAT without port
        forwarding, a tailnet-only deployment — set <code>ORB_RELAY_MODE=pull</code>. It needs no
        DNS record, TLS certificate, or firewall rule of its own, and tolerates a transient broker
        outage more gracefully (see the release checklist's known-warnings table below). Use push
        only once you already have a stable, publicly reachable HTTPS origin for this instance — the
        Direct App setup wizard, for instance, always requires one anyway, so an operator running
        Direct App today has it available for brokered push mode too. See{" "}
        <Link to="/docs/self-hosting-security">Security</Link>'s TLS termination section for how to
        stand one up: the <code>caddy</code> profile for a public domain, or note that{" "}
        <code>tailscale</code>'s private tailnet address does not satisfy push mode's
        internet-reachable requirement — pull mode is the right fit for a Tailscale-only instance.
      </Callout>
      <Callout variant="warn" title="Brokered mode operational risks">
        Before enabling this for anyone outside a controlled managed-beta cohort, weigh: (1){" "}
        <strong>rate-limit blast radius</strong> — every brokered install's GitHub API traffic draws
        from token pools gittensory manages, so one misbehaving or high-volume install can degrade
        every other brokered install; (2) <strong>quota management</strong> — there is no automatic
        per-install cap on how much of that shared budget one enrollment can consume; (3){" "}
        <strong>support burden</strong> — a broken brokered install looks like a gittensory outage
        to its operator, not a self-host misconfiguration, and lands as a support request on
        gittensory directly; (4) <strong>abuse/misconfiguration risk</strong> — an enrollment secret
        that leaks or a misconfigured relay can mint tokens or receive webhook traffic for repos the
        intended operator doesn't control.
      </Callout>

      <h2>Minimum broker safeguards before a public rollout</h2>
      <p>
        A maintainer go/no-go checklist — do not open brokered enrollment beyond a small, known,
        controlled cohort until every item below is true:
      </p>
      <ul>
        <li>
          <strong>Enrollment quota</strong> — a hard cap on how many brokered installs can be active
          at once, not just an informal agreement.
        </li>
        <li>
          <strong>Per-install concurrency limit</strong> — one brokered install cannot occupy an
          unbounded share of the token-minting or webhook-relay pipeline.
        </li>
        <li>
          <strong>Per-install rate budget</strong> — a ceiling on GitHub API calls attributable to a
          single enrollment, independent of the other installs sharing the broker.
        </li>
        <li>
          <strong>Revocation path</strong> — an enrollment secret can be revoked immediately,
          without waiting for a deploy, when it's compromised or the install is abusive.
        </li>
        <li>
          <strong>Metrics broken out by enrollment</strong> — token-mint volume, webhook-relay
          volume, and error rate are visible per-enrollment, not only aggregated across every
          brokered install, so one bad actor is identifiable instead of hiding in the average.
        </li>
      </ul>
      <p>
        See <Link to="/docs/self-hosting-troubleshooting">Troubleshooting</Link> for what a degraded
        brokered relay looks like in logs today, and{" "}
        <Link to="/docs/self-hosting-release-checklist">the release checklist</Link>'s brokered-mode
        scenario for the smoke tests that exercise both relay modes.
      </p>

      <h2>Connectivity checks</h2>
      <p>
        Confirm you can reach the instance at all before checking GitHub's own webhook delivery:
      </p>
      <CodeBlock
        lang="bash"
        code={`curl https://reviews.example.com/health
curl https://reviews.example.com/ready`}
      />
      <p>
        <code>reviews.example.com</code> here stands in for whatever you're checking from — the{" "}
        <code>caddy</code> profile's domain, an existing reverse proxy, or (if you're on the same
        tailnet) a Tailscale instance's tailnet address on port 8787. This only confirms{" "}
        <em>you</em> can reach the instance, not that <em>GitHub</em> can — a Tailscale-only
        instance in push mode will pass this check and still never receive a real webhook, since
        GitHub itself cannot reach a private tailnet address (see the callout above on{" "}
        <code>PUBLIC_API_ORIGIN</code>).
      </p>
      <p>
        After installing the App on a test repo, open a small PR and confirm the webhook delivery
        appears in GitHub and a job appears in self-host logs — this is the check that actually
        proves GitHub can reach you. Continue with{" "}
        <Link to="/docs/self-hosting-operations">Operations</Link> for log and metric checks.
      </p>
    </DocsPage>
  );
}
