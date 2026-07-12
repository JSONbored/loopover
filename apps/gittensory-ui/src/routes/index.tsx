import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { AnimatedTerminal } from "@/components/site/animated-terminal";
import { ScoreabilityStory } from "@/components/site/home/scoreability-story";
import { PrQuietCompare } from "@/components/site/home/pr-quiet-compare";
import { NpmInstall } from "@/components/site/npm-install";
import { ProofOfPowerStats } from "@/components/site/proof-of-power-stats";
import { TrustStrip } from "@/components/site/trust-strip";
import { describeApiStatus, pingHealth, useApiStatus } from "@/lib/api/status";
import { MCP_PACKAGE_NAME, getLatestMcpVersion, useMcpPackageMetadata } from "@/lib/mcp-package";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Gittensory — Plan the work. Skip the noise." },
      {
        name: "description",
        content:
          "Deterministic base-agent layer for Gittensor OSS contribution mining. Plan better work, preflight branches, and keep maintainer review surfaces quiet.",
      },
      { property: "og:title", content: "Gittensory — Plan the work. Skip the noise." },
      {
        property: "og:description",
        content:
          "Deterministic base-agent layer for Gittensor OSS contribution mining — MCP for miners and agents, a quiet GitHub App for maintainers.",
      },
      { property: "og:url", content: "/" },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="w-full">
      <Hero />
      <ProofOfPowerStats />
      <MetaStrip />
      <AudienceSection />
      <ScoreabilitySection />
      <QuietSection />
      <Capabilities />
      <Boundary />
      <TrustSection />
      <Install />
      <ClosingCta />
      <div className="h-24" />
    </div>
  );
}

function Hero() {
  const { data } = useMcpPackageMetadata();
  const latestMcpVersion = getLatestMcpVersion(data);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 pt-20 pb-12 sm:px-6 sm:pt-28">
      <div className="grid items-start gap-12 sm:grid-cols-[1.05fr_1fr] sm:gap-16">
        <div>
          <div className="flex items-center gap-2 text-token-xs text-muted-foreground">
            <span aria-hidden className="size-1 rounded-full bg-coral" />
            MCP v{latestMcpVersion} · deterministic base agent
          </div>
          <h1 className="mt-5 text-token-3xl font-medium leading-token-tight tracking-tight text-foreground">
            Mine Gittensor like an engineer.
            <span className="block text-muted-foreground">Not like a bot.</span>
          </h1>
          <p className="mt-5 max-w-lg text-token-md leading-token-normal text-muted-foreground">
            Gittensory is the deterministic base-agent layer for Gittensor OSS contribution mining.
            Plan better work, preflight branches, and keep maintainer review surfaces quiet.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2">
            <Link
              to="/docs/quickstart"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token bg-coral px-4 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Install MCP →
            </Link>
            <Link
              to="/docs/maintainer-self-hosting"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              Self-host reviews →
            </Link>
            <Link
              to="/docs"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              Read the docs
            </Link>
          </div>
          <div className="mt-5">
            <NpmInstall className="w-full sm:max-w-md" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-token-xs">
            <Link to="/api" className="text-muted-foreground hover:text-foreground">
              Browse the API →
            </Link>
          </div>
        </div>
        <div className="sm:pt-1">
          <AnimatedTerminal />
        </div>
      </div>
    </section>
  );
}

function MetaStrip() {
  const { status, lastCheckedAt, connection } = useApiStatus();
  const { data } = useMcpPackageMetadata();
  const [now, setNow] = useState<number>(() => Date.now());
  const latestMcpVersion = getLatestMcpVersion(data);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const apiLabel =
    connection === "offline"
      ? "offline"
      : status === "ok"
        ? "healthy"
        : status === "loading"
          ? "checking…"
          : status === "degraded"
            ? "degraded"
            : status === "timeout"
              ? "timing out"
              : status === "unreachable"
                ? "unreachable"
                : "unknown";

  const freshness =
    lastCheckedAt == null
      ? "—"
      : (() => {
          const diff = Math.max(0, Math.floor((now - lastCheckedAt) / 1000));
          if (diff < 60) return `${diff}s ago`;
          if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
          return `${Math.floor(diff / 3600)}h ago`;
        })();

  const items = [
    { k: "MCP package", v: `${MCP_PACKAGE_NAME} v${latestMcpVersion}` },
    { k: "API", v: apiLabel },
    { k: "Last checked", v: freshness },
    { k: "Upstream drift", v: "monitored" },
  ];
  return (
    <div className="mx-auto w-full max-w-6xl border-t border-border px-4 sm:px-6">
      <dl className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.k} className="px-4 py-4 first:pl-0">
            <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              {it.k}
            </dt>
            <dd className="mt-1 font-mono text-token-xs text-foreground/85">{it.v}</dd>
          </div>
        ))}
      </dl>
      <div className="-mt-1 flex items-center justify-end pb-3">
        <button
          type="button"
          onClick={() => {
            void pingHealth(true);
          }}
          aria-label={`Recheck API. Current: ${describeApiStatus(status)}`}
          className="rounded-token px-2 py-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground focus-ring motion-reduce:transition-none"
        >
          Recheck →
        </button>
      </div>
    </div>
  );
}

function AudienceSection() {
  const cols = [
    {
      who: "For miners",
      to: "/miners" as const,
      tools: ["plan-next-work", "preflight-branch", "explain-blockers", "prepare-pr-packet"],
      blurb: "Find the next move, clear queue pressure, and ship a packet that won't get flagged.",
    },
    {
      who: "For maintainers",
      to: "/maintainers" as const,
      tools: ["@gittensory help", "preflight", "miner-context", "duplicate-check"],
      blurb:
        "Confirmed-miner context without check noise. One sticky comment, one label, on demand.",
    },
    {
      who: "For coding agents",
      to: "/agents" as const,
      tools: ["stdio MCP", "remote MCP", "structured tools", "Codex · Claude · Cursor"],
      blurb: "Deterministic tool schemas your agent can actually plan against. Metadata only.",
    },
  ];
  return (
    <section className="mx-auto mt-24 w-full max-w-6xl border-t border-border px-4 pt-16 sm:px-6">
      <header>
        <div className="text-token-xs text-muted-foreground">What it gives you</div>
        <h2 className="mt-2 max-w-2xl text-token-xl font-medium tracking-tight">
          One base layer, three audiences, no surprises.
        </h2>
      </header>
      <div className="mt-10 grid divide-y divide-border border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {cols.map((c) => (
          <Link
            key={c.who}
            to={c.to}
            className="group hover-surface focus-ring flex flex-col gap-4 rounded-token py-6 sm:px-6"
          >
            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              {c.who}
            </div>
            <p className="text-token-md text-foreground/90">{c.blurb}</p>
            <ul className="mt-auto space-y-1 font-mono text-token-xs text-muted-foreground">
              {c.tools.map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <span aria-hidden className="accent-bullet" />
                  {t}
                </li>
              ))}
            </ul>
            <span className="text-token-xs text-foreground/70 transition-colors group-hover:text-coral">
              Open guide →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ScoreabilitySection() {
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl border-t border-border px-4 pt-16 sm:px-6">
      <header className="max-w-2xl">
        <div className="text-token-xs text-muted-foreground">Scoreability, explained</div>
        <h2 className="mt-2 text-token-xl font-medium tracking-tight">
          See the upside before you spend a commit on it.
        </h2>
        <p className="mt-3 text-token-sm text-muted-foreground">
          Every analysis returns five scenarios — current, underlying, clean-gate,
          after-pending-merges, best-reasonable. Estimates only, never guarantees, never raw trust
          scores.
        </p>
      </header>
      <div className="mt-12">
        <ScoreabilityStory />
      </div>
    </section>
  );
}

function QuietSection() {
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl border-t border-border px-4 pt-16 sm:px-6">
      <header className="max-w-2xl">
        <div className="text-token-xs text-muted-foreground">Stays quiet on PRs</div>
        <h2 className="mt-2 text-token-xl font-medium tracking-tight">
          Private intelligence. Public composure.
        </h2>
        <p className="mt-3 text-token-sm text-muted-foreground">
          No always-on check runs. No score numbers in the public thread. One sticky comment for
          confirmed miners, and a configured label — that's it.
        </p>
      </header>
      <div className="mt-10">
        <PrQuietCompare />
      </div>
    </section>
  );
}

function Capabilities() {
  const items = [
    {
      k: "Branch analysis",
      v: "Metadata-only inputs yield lane context, scoreability scenarios, and ranked next actions.",
    },
    {
      k: "Scoreability",
      v: "Current, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only — never guarantees.",
    },
    {
      k: "Upstream drift",
      v: "Versioned snapshots of the Gittensor source and ruleset flag stale assumptions before they break your plan.",
    },
    {
      k: "Decision pack",
      v: "Canonical private payload per miner: official stats, outcome history, lane context, repo targets, freshness, provenance.",
    },
    {
      k: "Maintainer packets",
      v: "Reviewability and readiness reports for a PR. Confirmed-miner context. One sticky comment, one label.",
    },
    {
      k: "Repo readiness",
      v: "Registration readiness, Gittensor config recommendation, label policy, settings preview, intake health.",
    },
  ];
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl border-t border-border px-4 pt-16 sm:px-6">
      <div className="text-token-xs text-muted-foreground">Capabilities</div>
      <h2 className="mt-2 text-token-xl font-medium tracking-tight">
        A static base layer for moving work.
      </h2>
      <dl className="mt-6 divide-y divide-border border-y border-border">
        {items.map((it) => (
          <div key={it.k} className="grid gap-2 py-4 sm:grid-cols-[14rem_1fr] sm:gap-8">
            <dt className="text-token-sm font-medium text-foreground">{it.k}</dt>
            <dd className="text-token-sm text-muted-foreground">{it.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Boundary() {
  const lines = [
    "MCP transmits metadata only — never source code.",
    "No PAT input. CLI uses GitHub Device Flow; session tokens are Gittensory-issued.",
    "No wallet, hotkey, or trust-score surfaces.",
    "Confirmed-miner PRs get at most one sanitized sticky comment and a configured label.",
    "Maintainer commands return packets to the maintainer, not to the public PR.",
  ];
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl border-t border-border px-4 pt-16 sm:px-6">
      <div className="text-token-xs text-muted-foreground">Public / private boundary</div>
      <h2 className="mt-2 text-token-xl font-medium tracking-tight">
        Private context for you. Quiet output for the repo.
      </h2>
      <ul className="mt-6 divide-y divide-border border-y border-border">
        {lines.map((l) => (
          <li key={l} className="py-3 text-token-sm text-muted-foreground">
            {l}
          </li>
        ))}
      </ul>
      <Link
        to="/docs/privacy-security"
        className="mt-4 inline-block text-token-sm text-coral hover:underline"
      >
        Read the privacy posture →
      </Link>
    </section>
  );
}

function Install() {
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl border-t border-border px-4 pt-16 sm:px-6">
      <div className="text-token-xs text-muted-foreground">Get started</div>
      <h2 className="mt-2 text-token-xl font-medium tracking-tight">
        Wire it into your client in under a minute.
      </h2>
      <p className="mt-2 max-w-2xl text-token-sm text-muted-foreground">
        Miners use the CLI. Coding agents wire the MCP via stdio. Same package, two starting points.
      </p>
      <div className="mt-8">
        <ClientSetupTabs />
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-token border-hairline bg-card/40 p-4">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Install the MCP
          </div>
          <NpmInstall className="mt-3" />
          <pre className="mt-3 overflow-x-auto rounded-token border-hairline bg-background p-3 font-mono text-token-xs leading-token-relaxed text-foreground/90">
            {`gittensory-mcp login
gittensory-mcp analyze-branch --login your-login --json`}
          </pre>
        </div>
        <div className="rounded-token border-hairline bg-card/40 p-4">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Read the docs
          </div>
          <ul className="mt-3 divide-y divide-border">
            {[
              {
                to: "/docs/quickstart" as const,
                label: "Quickstart",
                hint: "Install + first analysis",
              },
              {
                to: "/docs/mcp-clients" as const,
                label: "MCP clients",
                hint: "Codex · Claude · Cursor",
              },
              {
                to: "/docs/scoreability" as const,
                label: "Scoreability",
                hint: "How projections work",
              },
              {
                to: "/docs/privacy-security" as const,
                label: "Privacy & security",
                hint: "Public / private boundary",
              },
            ].map((d) => (
              <li key={d.to}>
                <Link
                  to={d.to}
                  className="group flex items-center justify-between gap-3 py-2.5 text-token-sm text-foreground/85 transition-colors duration-150 hover:text-foreground focus-ring rounded-token"
                >
                  <span className="font-medium">{d.label}</span>
                  <span className="text-token-xs text-muted-foreground group-hover:text-mint">
                    {d.hint} →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-token-sm">
        <Link to="/docs/quickstart" className="text-coral hover:underline">
          Quickstart →
        </Link>
        <Link to="/api" className="text-muted-foreground hover:text-foreground">
          API reference
        </Link>
        <Link to="/docs/mcp-clients" className="text-muted-foreground hover:text-foreground">
          Configure Claude / Cursor / Codex
        </Link>
      </div>
    </section>
  );
}

type ClientTabId = "miners" | "codex" | "claude" | "cursor" | "remote";

const CLIENT_TABS: Array<{
  id: ClientTabId;
  label: string;
  audience: "Miners" | "Agents";
  filename: string;
  lang: string;
  snippet: string;
}> = [
  {
    id: "miners",
    label: "Miner CLI",
    audience: "Miners",
    filename: "terminal",
    lang: "bash",
    snippet: `npm i -g @jsonbored/gittensory-mcp@latest
gittensory-mcp login
gittensory-mcp analyze-branch --login your-login --json`,
  },
  {
    id: "codex",
    label: "Codex",
    audience: "Agents",
    filename: "~/.codex/config.toml",
    lang: "toml",
    snippet: `[mcp_servers.gittensory]
command = "npx"
args = ["-y", "@jsonbored/gittensory-mcp@latest", "--stdio"]`,
  },
  {
    id: "claude",
    label: "Claude Desktop",
    audience: "Agents",
    filename: "claude_desktop_config.json",
    lang: "json",
    snippet: `{
  "mcpServers": {
    "gittensory": {
      "command": "npx",
      "args": ["-y", "@jsonbored/gittensory-mcp@latest", "--stdio"]
    }
  }
}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    audience: "Agents",
    filename: ".cursor/mcp.json",
    lang: "json",
    snippet: `{
  "mcpServers": {
    "gittensory": {
      "command": "npx",
      "args": ["-y", "@jsonbored/gittensory-mcp@latest", "--stdio"]
    }
  }
}`,
  },
  {
    id: "remote",
    label: "Remote MCP",
    audience: "Agents",
    filename: "endpoint",
    lang: "http",
    snippet: `https://gittensory-api.aethereal.dev/mcp`,
  },
];

function ClientSetupTabs() {
  const [active, setActive] = useState<ClientTabId>(() => {
    if (typeof window === "undefined") return "miners";
    return (window.localStorage.getItem("gt:install-tab") as ClientTabId) ?? "miners";
  });
  const [copied, setCopied] = useState(false);
  const current = CLIENT_TABS.find((t) => t.id === active) ?? CLIENT_TABS[0];

  useEffect(() => {
    try {
      window.localStorage.setItem("gt:install-tab", active);
    } catch {
      /* noop */
    }
  }, [active]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(current.snippet);
      setCopied(true);
      toast.success(`Copied ${current.label} setup`, {
        description: `Paste into ${current.filename}.`,
      });
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Copy failed", { description: "Select the snippet and copy manually." });
    }
  };

  return (
    <div className="rounded-token border border-border bg-card/40">
      <div
        role="tablist"
        aria-label="Install snippets"
        className="flex flex-wrap gap-1 border-b border-border p-1.5"
      >
        {CLIENT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-token px-2.5 py-1 text-token-xs font-medium transition-colors duration-150 focus-ring motion-reduce:transition-none",
              active === t.id
                ? "bg-foreground/[0.06] text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{t.label}</span>
            <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground/80">
              · {t.audience}
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          {current.filename} · {current.lang}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy snippet"}
          className="inline-flex h-7 items-center gap-1.5 rounded-token px-2 text-token-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-ring motion-reduce:transition-none"
        >
          {copied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-background/60 p-4 font-mono text-token-xs leading-token-relaxed text-foreground/90">
        {current.snippet}
      </pre>
    </div>
  );
}

function TrustSection() {
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl px-4 sm:px-6">
      <TrustStrip />
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="mx-auto mt-24 w-full max-w-5xl px-4 sm:px-6">
      <div className="rounded-token border border-border bg-card/40 p-6 sm:p-8">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Ready when you are
            </div>
            <h2 className="mt-2 font-display text-token-xl font-medium tracking-tight">
              Skip the noise. Plan the work.
            </h2>
            <p className="mt-2 text-token-sm text-muted-foreground">
              Install the MCP, run an analysis, and see the next move with five scoreability
              scenarios — no PATs, no source upload, no public score numbers.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Link
              to="/docs/quickstart"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token bg-coral px-4 text-token-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              Install MCP →
            </Link>
            <Link
              to="/app"
              className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-4 text-token-sm font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-ring motion-reduce:transition-none"
            >
              Open workbench
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
