import { Link } from "@tanstack/react-router";
import { Menu, X, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { McpVersionBadge } from "./mcp-version-badge";
import { GittensoryMark } from "./mark";
import { CommandPalette } from "./command-palette";
import { GithubStatsChip } from "./github-stats-chip";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts";
import { ThemeToggle } from "./theme-toggle";

const nav = [
  { to: "/miners", label: "Miners" },
  { to: "/maintainers", label: "Maintainers" },
  { to: "/agents", label: "Agents" },
  { to: "/api", label: "API" },
  { to: "/roadmap", label: "Roadmap" },
] as const;

const docsMenu = [
  { to: "/docs/quickstart", label: "Quickstart", hint: "Install MCP + first run" },
  { to: "/docs/mcp-clients", label: "MCP clients", hint: "Codex · Claude · Cursor" },
  { to: "/docs/github-app", label: "GitHub App", hint: "Quiet maintainer setup" },
  { to: "/docs/scoreability", label: "Scoreability", hint: "How projections work" },
  { to: "/docs/upstream-drift", label: "Upstream drift", hint: "Snapshot freshness" },
  { to: "/docs/troubleshooting", label: "Troubleshooting", hint: "Common errors" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const docsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!docsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDocsOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (docsRef.current && !docsRef.current.contains(e.target as Node)) setDocsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [docsOpen]);

  return (
    <header className="sticky top-0 z-40 border-b-hairline bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-token-sm font-medium tracking-tight text-foreground transition-opacity hover:opacity-80 focus-ring rounded-token"
        >
          <GittensoryMark className="size-4 text-foreground" />
          <span>Gittensory</span>
        </Link>

        <nav className="hidden flex-1 items-center gap-4 md:flex lg:gap-5">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeProps={{
                className: "text-foreground after:scale-x-100 after:bg-mint",
              }}
              inactiveProps={{
                className:
                  "text-muted-foreground hover:after:scale-x-100 hover:after:bg-foreground/40",
              }}
              className="relative text-token-sm transition-colors duration-150 motion-reduce:transition-none hover:text-foreground after:content-[''] after:absolute after:left-0 after:right-0 after:-bottom-[18px] after:h-[2px] after:rounded-full after:bg-transparent after:scale-x-0 after:origin-left after:transition-transform after:duration-200 motion-reduce:after:transition-none focus-ring"
            >
              {n.label}
            </Link>
          ))}

          {/* Docs with hover menu */}
          <div
            ref={docsRef}
            className="relative"
            onMouseEnter={() => setDocsOpen(true)}
            onMouseLeave={() => setDocsOpen(false)}
          >
            <Link
              to="/docs"
              activeProps={{ className: "text-foreground after:scale-x-100 after:bg-mint" }}
              inactiveProps={{
                className:
                  "text-muted-foreground hover:after:scale-x-100 hover:after:bg-foreground/40",
              }}
              onFocus={() => setDocsOpen(true)}
              onBlur={(e) => {
                if (!docsRef.current?.contains(e.relatedTarget as Node)) setDocsOpen(false);
              }}
              aria-haspopup="true"
              aria-expanded={docsOpen}
              className="relative inline-flex items-center gap-1 text-token-sm transition-colors duration-150 motion-reduce:transition-none hover:text-foreground after:content-[''] after:absolute after:left-0 after:right-4 after:-bottom-[18px] after:h-[2px] after:rounded-full after:bg-transparent after:scale-x-0 after:origin-left after:transition-transform after:duration-200 motion-reduce:after:transition-none focus-ring"
            >
              Docs
              <ChevronDown
                className={`size-3 opacity-60 transition-transform duration-150 ${docsOpen ? "rotate-180" : ""}`}
              />
            </Link>
            {docsOpen && (
              <div
                className="absolute left-1/2 top-full z-50 mt-3 w-[28rem] -translate-x-1/2 overflow-hidden rounded-token border-hairline bg-popover/95 shadow-2xl backdrop-blur animate-in fade-in slide-in-from-top-1 duration-150 motion-reduce:animate-none"
                onBlur={(e) => {
                  if (!docsRef.current?.contains(e.relatedTarget as Node)) setDocsOpen(false);
                }}
              >
                <div className="grid grid-cols-2 gap-1 p-2">
                  {docsMenu.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setDocsOpen(false)}
                      activeProps={{ className: "bg-muted/60 text-foreground" }}
                      className="group relative flex flex-col gap-0.5 rounded-token px-3 py-2 text-token-sm text-foreground/85 transition-all duration-150 motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-ring"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="size-1.5 rounded-full bg-mint opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover:opacity-100 group-focus-visible:opacity-100" />
                        {item.label}
                      </span>
                      <span className="pl-3 text-token-2xs text-muted-foreground">{item.hint}</span>
                    </Link>
                  ))}
                </div>
                <div className="border-t-hairline bg-muted/30 px-3 py-2">
                  <Link
                    to="/docs"
                    onClick={() => setDocsOpen(false)}
                    className="inline-flex items-center gap-1 text-token-xs text-muted-foreground transition-colors hover:text-mint focus-ring rounded-token"
                  >
                    All documentation →
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Promoted App pill */}
          <Link
            to="/app"
            activeProps={{ className: "text-foreground" }}
            inactiveProps={{ className: "text-foreground/90" }}
            className="gradient-border ml-1 inline-flex items-center gap-1.5 rounded-token px-3 h-7 text-token-xs font-medium transition-all duration-150 motion-reduce:transition-none motion-reduce:hover:translate-y-0 hover:-translate-y-[1px] focus-ring"
          >
            <span className="size-1.5 rounded-full bg-mint shadow-[0_0_8px_var(--mint)]" />
            App
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <CommandPalette />
          <ThemeToggle />
          <McpVersionBadge className="hidden lg:block" />
          <GithubStatsChip className="hidden sm:inline-flex" />
          <KeyboardShortcutsDialog />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
            className="inline-flex h-8 w-8 items-center justify-center rounded-token text-muted-foreground transition-colors hover:bg-muted md:hidden focus-ring"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t-hairline md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col px-4 py-2 sm:px-6">
            {[...nav, { to: "/docs", label: "Docs" }, { to: "/app", label: "App" }].map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                activeProps={{ className: "text-foreground bg-muted/40" }}
                inactiveProps={{ className: "text-muted-foreground" }}
                className="rounded-token px-2 py-2 text-token-sm transition-colors hover:text-foreground focus-ring"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
