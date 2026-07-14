import { Link } from "@tanstack/react-router";
import { Github } from "lucide-react";

import { LoopOverMark } from "./mark";
import { HealthDot } from "./health-dot";

const cols = [
  {
    title: "Product",
    links: [
      { to: "/miners", label: "For miners" },
      { to: "/maintainers", label: "For maintainers" },
      { to: "/agents", label: "For coding agents" },
      { to: "/extension", label: "Browser extension" },
    ],
  },
  {
    title: "Docs",
    links: [
      { to: "/docs/quickstart", label: "Quickstart" },
      { to: "/docs/mcp-clients", label: "MCP clients" },
      { to: "/docs/github-app", label: "GitHub App" },
      { to: "/docs/maintainer-self-hosting", label: "Self-host reviews" },
      { to: "/docs/privacy-security", label: "Privacy & security" },
    ],
  },
  {
    title: "Reference",
    links: [
      { to: "/api", label: "API reference" },
      { to: "/docs/scoreability", label: "Scoreability" },
      { to: "/docs/upstream-drift", label: "Upstream drift" },
      { to: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Project",
    links: [
      { to: "/roadmap", label: "Roadmap" },
      { to: "/docs/troubleshooting", label: "Troubleshooting" },
      { to: "/docs", label: "All docs" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border bg-transparent">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] lg:px-8">
        <div>
          <Link
            to="/"
            aria-label="LoopOver"
            className="flex items-center gap-0.5 font-display text-token-base font-semibold"
          >
            <LoopOverMark className="size-6" />
            <span aria-hidden>ittensory</span>
          </Link>
          <p className="mt-3 max-w-sm text-token-sm text-muted-foreground">
            Deterministic base-agent layer for Gittensor OSS contribution mining. Built for the
            Gittensor ecosystem — not affiliated with the official subnet.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <a
              href="https://github.com/jsonbored/gittensory"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 w-8 items-center justify-center rounded-token border border-border text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-strong focus-ring"
              aria-label="LoopOver repository on GitHub"
            >
              <Github className="size-4" />
            </a>
            <HealthDot />
          </div>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <div className="mb-3 text-token-xs font-mono uppercase tracking-wider text-muted-foreground">
              {c.title}
            </div>
            <ul className="space-y-2 text-token-sm">
              {c.links.map((l) => (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    className="text-foreground/80 transition-colors duration-150 hover:text-mint focus-ring rounded-token"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-3 px-4 py-5 text-token-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="font-mono">
            <span className="text-foreground/70">loopover.ai</span>
            <span className="mx-2 opacity-40">·</span>
            <span>api: api.loopover.ai</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <a
              href="https://github.com/jsonbored"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-token border-hairline px-2 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-mint hover:border-strong focus-ring"
            >
              <Github className="size-3" />
              @jsonbored
            </a>
            <span>
              © {new Date().getFullYear()} LoopOver, an{" "}
              <a
                href="https://aethereal.dev"
                target="_blank"
                rel="noreferrer"
                className="text-foreground/80 underline-offset-4 transition-colors duration-150 hover:text-mint hover:underline focus-ring rounded-token"
              >
                Aethereal
              </a>{" "}
              OSS project.
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
