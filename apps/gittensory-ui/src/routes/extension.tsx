import { createFileRoute } from "@tanstack/react-router";
import { Download, Lock, Shield, GitPullRequestArrow } from "lucide-react";
import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";

import { Section, Eyebrow, Callout } from "@/components/site/primitives";
import { BoundaryBadge, StatusPill } from "@/components/site/control-primitives";
import { Reveal } from "@/components/site/reveal";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/extension")({
  head: () => ({
    meta: [
      { title: "Browser extension — Gittensory" },
      {
        name: "description",
        content:
          "Private maintainer overlays on github.com. Never shown to PR authors or the public — reviewability context where you already work.",
      },
      { property: "og:title", content: "Gittensory · maintainer browser extension" },
      {
        property: "og:description",
        content:
          "A private overlay on GitHub PR pages that surfaces miner context, scoreability projections, and reviewability hints.",
      },
      { property: "og:url", content: "/extension" },
    ],
    links: [{ rel: "canonical", href: "/extension" }],
  }),
  component: ExtensionPage,
});

function ExtensionPage() {
  return (
    <>
      <Section className="relative pt-16 pb-12 sm:pt-24">
        <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <Eyebrow>Self-hosted package</Eyebrow>
            <h1 className="mt-5 text-token-2xl font-medium tracking-tight text-foreground text-foreground">
              Maintainer overlays on the GitHub you already use.
            </h1>
            <p className="mt-4 max-w-xl text-token-base text-muted-foreground">
              The Gittensory browser extension surfaces miner context, scoreability projections, and
              reviewability hints on PR pages — visible only to the maintainer running it. Nothing
              is injected into the page or shown to the PR author.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <a
                href="/downloads/gittensory-extension.zip"
                className="inline-flex items-center gap-2 rounded-token border border-mint/40 bg-mint px-4 py-2 text-token-sm font-medium text-primary-foreground hover:brightness-110"
              >
                <Download className="size-4" />
                Download extension
              </a>
              <ExtensionTokenButton />
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <StatusPill status="info">Maintainer-only</StatusPill>
              <BoundaryBadge boundary="private-api" />
              <StatusPill status="ready">Live API integration</StatusPill>
            </div>
          </div>

          <Reveal>
            <OverlayDemo />
          </Reveal>
        </div>
      </Section>

      <Section className="py-16">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: <Lock className="size-4" />,
              title: "Never shown publicly",
              body: "Overlays render in your browser only. The DOM injection never reaches the PR author or other visitors.",
            },
            {
              icon: <Shield className="size-4" />,
              title: "No source upload",
              body: "The extension uses the existing private API. It reads metadata you already have permission to see — nothing more.",
            },
            {
              icon: <GitPullRequestArrow className="size-4" />,
              title: "Lives where you work",
              body: "No tab-switching to a dashboard. Context appears next to the diff, the review tab, and the files-changed view.",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-token border border-border bg-transparent p-5">
              <div className="mb-3 inline-flex size-8 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint">
                {f.icon}
              </div>
              <h3 className="font-display text-token-base font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-token-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section className="pb-24">
        <Callout variant="safety">
          <strong>Privacy posture.</strong> The extension does not read the PR diff, post comments,
          or open issues. It calls the same private Gittensory API endpoints you already use, then
          renders the response in your local DOM. No analytics SDKs, no third-party trackers.
        </Callout>
      </Section>
    </>
  );
}

const EXTENSION_PANELS = [
  {
    label: "Reviewability",
    badge: "live",
    rows: [
      { k: "endpoint", v: "/v1/extension/pull-context" },
      { k: "auth", v: "extension session" },
      { k: "boundary", v: "private" },
    ],
  },
  {
    label: "Contributor",
    badge: "cached",
    rows: [
      { k: "profile", v: "backend" },
      { k: "history", v: "read-only" },
      { k: "public post", v: "never" },
    ],
  },
  {
    label: "Install",
    badge: "manual",
    rows: [
      { k: "package", v: "Manifest V3" },
      { k: "store", v: "out of scope" },
      { k: "source", v: "bundled" },
    ],
  },
] as const;

function ExtensionTokenButton() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex max-w-full flex-col gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await apiFetch<{ token: string }>(
            `${getApiOrigin().replace(/\/$/, "")}/v1/auth/extension/session`,
            {
              method: "POST",
              label: "Extension token",
              credentials: "include",
              headers: { Accept: "application/json" },
            },
          );
          setBusy(false);
          if (!result.ok) {
            toast.error("Extension token not created", {
              description:
                result.status === 403
                  ? "Sign in to the app first, then try again."
                  : result.message,
            });
            return;
          }
          setToken(result.data.token);
          await navigator.clipboard?.writeText(result.data.token).catch(() => undefined);
          toast.success("Extension token created", { description: "Copied to clipboard." });
        }}
        className="inline-flex items-center gap-2 rounded-token border border-border bg-transparent px-4 py-2 text-token-sm font-medium hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Creating token…" : "Create extension token"}
      </button>
      {token && (
        <code className="max-w-[320px] truncate rounded-token border border-border bg-background/60 px-2 py-1 font-mono text-token-2xs text-muted-foreground">
          {token}
        </code>
      )}
    </div>
  );
}

function OverlayDemo() {
  const [active, setActive] = useState(0);
  return (
    <div className="relative rounded-token border border-border bg-transparent p-2">
      {/* faux github header */}
      <div className="rounded-token border border-border bg-[oklch(0.18_0.005_260)]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-token-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-[oklch(0.7_0.18_25)]/60" />
          <span className="size-2 rounded-full bg-[oklch(0.8_0.15_85)]/60" />
          <span className="size-2 rounded-full bg-success/60" />
          <span className="ml-2 truncate font-mono text-token-2xs">
            github.com/jsonbored/gittensory/pull/1218
          </span>
        </div>
        <div className="grid gap-3 p-3 sm:grid-cols-[1.4fr_1fr]">
          {/* faux PR body */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-token-xs">
              <GitPullRequestArrow className="size-3.5 text-success" />
              <span className="text-foreground">Tighten queue-cap copy</span>
              <span className="rounded border border-success/30 bg-success/5 px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-success">
                open
              </span>
            </div>
            <div className="rounded-token border border-border/50 bg-background/40 p-2 text-[12px] text-muted-foreground">
              <div className="text-foreground/80">
                jsonbored wants to merge 1 commit into main from feat/queue-copy
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 text-center font-mono text-token-2xs">
                <div className="rounded bg-success/10 py-1 text-success">+12</div>
                <div className="rounded bg-danger/10 py-1 text-danger">−4</div>
                <div className="rounded bg-background/60 py-1 text-muted-foreground">1 file</div>
              </div>
            </div>
            <div className="rounded-token border border-border/50 bg-background/40 p-2 text-token-2xs text-muted-foreground">
              <span className="text-mint">checks</span> · 4 passing · 0 failing
            </div>
          </div>

          {/* gittensory overlay panel */}
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            className=" relative rounded-token border border-mint/40 bg-mint/[0.04] p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex size-5 items-center justify-center rounded-token bg-mint text-token-2xs font-bold text-primary-foreground">
                  G
                </span>
                <span className="text-token-xs text-muted-foreground">gittensory overlay</span>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                you only
              </span>
            </div>
            <div className="mb-2 flex gap-1">
              {EXTENSION_PANELS.map((p, i) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    "rounded px-2 py-0.5 text-token-2xs font-mono uppercase tracking-wider transition-colors",
                    active === i
                      ? "bg-mint/20 text-mint"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label.split(" ")[0]}
                </button>
              ))}
            </div>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-token-sm font-medium text-foreground">
                  {EXTENSION_PANELS[active].label}
                </span>
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {EXTENSION_PANELS[active].badge}
                </span>
              </div>
              <dl className="space-y-1 text-[12px]">
                {EXTENSION_PANELS[active].rows.map((r) => (
                  <div key={r.k} className="flex items-baseline justify-between gap-2">
                    <dt className="font-mono text-muted-foreground">{r.k}</dt>
                    <dd className="font-mono text-foreground/90">{r.v}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
