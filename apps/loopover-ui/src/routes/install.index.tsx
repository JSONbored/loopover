import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, UserPlus, Github, ShieldCheck } from "lucide-react";

import { Section, SectionTitle, Card, Callout, Eyebrow } from "@/components/site/primitives";

// Self-serve signup & App-install entry surface (part of #4802). This is the front door of the
// signup -> install -> confirm-scoped-permissions flow: it explains the three steps and routes a new
// customer to the existing GitHub App configuration guide, with a link to the scoped-permissions
// confirmation step (/install/permissions). It reads no secrets and changes no auth backend -- the
// install itself is completed on GitHub.

export const Route = createFileRoute("/install/")({
  head: () => ({
    meta: [
      { title: "Install LoopOver — self-serve setup" },
      {
        name: "description",
        content:
          "Sign up, install the LoopOver App on your own repository, and confirm the scoped permissions being granted — self-serve, no engineering step required.",
      },
      { property: "og:title", content: "Install LoopOver — self-serve setup" },
      {
        property: "og:description",
        content:
          "A self-serve signup-through-install flow: connect your repository and grant scoped permissions.",
      },
      { property: "og:url", content: "/install" },
    ],
    links: [{ rel: "canonical", href: "/install" }],
  }),
  component: InstallPage,
});

const STEPS = [
  {
    icon: UserPlus,
    title: "Sign up",
    description:
      "Create your account. No engineering involvement — you own the connection to your repository from the start.",
  },
  {
    icon: Github,
    title: "Install the App",
    description:
      "Add the LoopOver GitHub App to the repositories you want reviewed. You choose which repos it can see.",
  },
  {
    icon: ShieldCheck,
    title: "Confirm scoped permissions",
    description:
      "Review exactly which permissions you're granting before you finish — scoped to what review needs, nothing more.",
    to: "/install/permissions" as const,
  },
];

export function InstallPage() {
  return (
    <>
      <Section className="pt-16 pb-12 sm:pt-24">
        <div className="max-w-3xl">
          <Eyebrow accent>Self-serve setup</Eyebrow>
          <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
            Connect your repository in three steps.
          </h1>
          <p className="mt-4 max-w-2xl text-token-md text-muted-foreground">
            Sign up, install the LoopOver App on your own repository, and confirm the scoped
            permissions being granted — without a manual or engineering step.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2">
            <Link
              to="/docs/github-app"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token bg-coral px-4 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Install on GitHub
              <ArrowRight className="size-3.5" />
            </Link>
            <Link
              to="/docs/beta-onboarding"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              Read the onboarding guide
            </Link>
          </div>
        </div>
      </Section>

      <Section className="py-0">
        <SectionTitle
          eyebrow="How it works"
          title="From signup to a connected repo"
          description="Each step is self-serve. You stay in control of which repositories the App can access and what it's allowed to do."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <Card key={step.title}>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                  <span className="font-mono text-token-2xs uppercase tracking-wider">
                    Step {index + 1}
                  </span>
                </div>
                <h3 className="mt-3 text-token-md font-medium text-foreground">{step.title}</h3>
                <p className="mt-1.5 text-token-sm text-muted-foreground">{step.description}</p>
                {"to" in step && step.to ? (
                  <Link
                    to={step.to}
                    className="mt-3 inline-flex items-center gap-1 text-token-sm font-medium text-foreground underline underline-offset-2 focus-ring"
                  >
                    Review the exact scopes
                    <ArrowRight className="size-3.5" />
                  </Link>
                ) : null}
              </Card>
            );
          })}
        </div>
      </Section>

      <Section className="pt-12 pb-24">
        <div className="max-w-3xl">
          <Callout variant="safety" title="Scoped by design">
            LoopOver requests only the permissions review needs, on only the repositories you
            choose. You confirm the exact scopes on GitHub before the install completes, and you can
            review or revoke them at any time from your repository's installed-Apps settings. See{" "}
            <Link
              to="/docs/privacy-security"
              className="text-foreground underline underline-offset-2"
            >
              privacy &amp; security
            </Link>{" "}
            for what is and isn't stored.
          </Callout>
        </div>
      </Section>
    </>
  );
}
