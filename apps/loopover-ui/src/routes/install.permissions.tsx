import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck, Eye, PencilLine, Bell } from "lucide-react";

import { Section, SectionTitle, Card, Callout, Eyebrow } from "@/components/site/primitives";

// Self-serve "confirm scoped permissions" surface (part of #4802). This is the third step of the
// signup -> install -> confirm-scoped-permissions flow whose entry lives at /install: before a
// customer finishes the GitHub install, this page shows exactly which repository permissions the App
// requests and why, so the grant on GitHub holds no surprises. The permission set mirrors the
// canonical REQUIRED_INSTALLATION_PERMISSIONS / OPTIONAL_* constants in src/github/backfill.ts (the
// same source install-health checks against) -- baseline access is always requested; the write scopes
// are only exercised when the matching repo setting is enabled, so they are shown as opt-in. This is a
// read-only informational surface: it reads no secrets and changes no auth backend, and the real grant
// still happens on GitHub.

export const Route = createFileRoute("/install/permissions")({
  head: () => ({
    meta: [
      { title: "Scoped permissions — LoopOver install" },
      {
        name: "description",
        content:
          "Review exactly which repository permissions the LoopOver GitHub App requests, and why, before you finish installing — scoped to what review needs, nothing more.",
      },
      { property: "og:title", content: "Scoped permissions — LoopOver install" },
      {
        property: "og:description",
        content:
          "The exact scopes the LoopOver App requests: baseline read access plus opt-in write scopes only for the output you enable.",
      },
      { property: "og:url", content: "/install/permissions" },
    ],
    links: [{ rel: "canonical", href: "/install/permissions" }],
  }),
  component: InstallPermissionsPage,
});

type Scope = {
  icon: typeof Eye;
  name: string;
  access: "Read" | "Write";
  summary: string;
};

// Baseline scopes every installation requests (REQUIRED_INSTALLATION_PERMISSIONS in
// src/github/backfill.ts: metadata:read, pull_requests:read, issues:write).
const REQUIRED_SCOPES: Scope[] = [
  {
    icon: Eye,
    name: "Metadata",
    access: "Read",
    summary:
      "Baseline access GitHub requires for any App — the repository's name, description, and topology. No file contents.",
  },
  {
    icon: Eye,
    name: "Pull requests",
    access: "Read",
    summary:
      "Read the diff, title, and description of a pull request so the review agent has something to review.",
  },
  {
    icon: PencilLine,
    name: "Issues",
    access: "Write",
    summary:
      "Post the review as a comment and apply the review labels. GitHub routes PR comments and labels through the Issues endpoints, so this is what publishing the result needs.",
  },
];

// Opt-in scopes: only requested/exercised when the matching repository setting is enabled
// (OPTIONAL_CHECK_RUN_PERMISSION / OPTIONAL_PR_WRITE_PERMISSION / OPTIONAL_CONTENTS_WRITE_PERMISSION).
const OPTIONAL_SCOPES: Array<Scope & { enabledBy: string }> = [
  {
    icon: ShieldCheck,
    name: "Checks",
    access: "Write",
    summary:
      "Publish the LoopOver Orb Review Agent check run on the pull request, so its verdict shows in the PR's checks.",
    enabledBy: "Enabled when you turn on check-run or review-agent enforcement.",
  },
  {
    icon: PencilLine,
    name: "Pull requests",
    access: "Write",
    summary:
      "Act on pull-request state — merge, close, approve, or request changes — when you let the agent enforce outcomes rather than only advise.",
    enabledBy: "Enabled when autonomy is set to act on PR state.",
  },
  {
    icon: PencilLine,
    name: "Contents",
    access: "Write",
    summary:
      "Write suggested fixes back to a branch when fix-handoff is turned on. Left at read-only otherwise.",
    enabledBy: "Enabled when fix-handoff writes are turned on.",
  },
];

// Webhook events the installation subscribes to (REQUIRED_INSTALLATION_EVENTS).
const EVENTS = ["issues", "issue_comment", "pull_request", "repository"];

function ScopeCard({ scope, footer }: { scope: Scope; footer?: string }) {
  const Icon = scope.icon;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon aria-hidden className="size-4" />
          <h3 className="text-token-md font-medium text-foreground">{scope.name}</h3>
        </div>
        <span className="rounded-token border border-border px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          {scope.access}
        </span>
      </div>
      <p className="mt-2 text-token-sm text-muted-foreground">{scope.summary}</p>
      {footer ? <p className="mt-2 text-token-2xs text-muted-foreground/80">{footer}</p> : null}
    </Card>
  );
}

export function InstallPermissionsPage() {
  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <Eyebrow accent>Step 3 · Confirm scoped permissions</Eyebrow>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Exactly what you&apos;re granting.
          </h1>
          <p className="mt-4 max-w-2xl text-token-md text-muted-foreground">
            Before you finish the install, here is every repository permission the LoopOver App
            requests — and why. GitHub shows you the same list to approve; nothing is granted until
            you confirm it there.
          </p>
          <div className="mt-7">
            <Link
              to="/install"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              <ArrowLeft className="size-3.5" />
              Back to setup steps
            </Link>
          </div>
        </div>
      </Section>

      <Section className="py-0">
        <SectionTitle
          eyebrow="Always requested"
          title="Baseline access"
          description="These scopes are needed for a review to happen at all: read the pull request, then publish the result."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {REQUIRED_SCOPES.map((scope) => (
            <ScopeCard key={scope.name} scope={scope} />
          ))}
        </div>
      </Section>

      <Section className="pt-12 pb-0">
        <SectionTitle
          eyebrow="Only if you enable it"
          title="Opt-in write scopes"
          description="LoopOver requests these only when the matching setting is on. Leave the setting off and the scope stays unused — advisory-only reviews never need them."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {OPTIONAL_SCOPES.map((scope) => (
            <ScopeCard
              key={`${scope.name}-${scope.access}`}
              scope={scope}
              footer={scope.enabledBy}
            />
          ))}
        </div>
      </Section>

      <Section className="pt-12 pb-0">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Bell aria-hidden className="size-4" />
            <h2 className="text-token-md font-medium text-foreground">Events it listens for</h2>
          </div>
          <p className="mt-2 text-token-sm text-muted-foreground">
            The installation subscribes to these webhook events so it knows when there&apos;s a pull
            request to review:
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {EVENTS.map((event) => (
              <li
                key={event}
                className="rounded-token border border-border px-2.5 py-1 font-mono text-token-2xs text-muted-foreground"
              >
                {event}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section className="pt-12 pb-24">
        <div className="max-w-3xl">
          <Callout variant="safety" title="You stay in control">
            You grant these on only the repositories you choose, and you can review or revoke them
            at any time from your repository&apos;s installed-Apps settings on GitHub. See{" "}
            <Link
              to="/docs/privacy-security"
              className="text-foreground underline underline-offset-2"
            >
              privacy &amp; security
            </Link>{" "}
            for what is and isn&apos;t stored.
          </Callout>
        </div>
      </Section>
    </>
  );
}
