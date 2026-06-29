import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Command, ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PaletteItem {
  label: string;
  to: string;
  hint?: string;
  group?: string;
}

const DEFAULT_ITEMS: PaletteItem[] = [
  { label: "Home", to: "/", group: "Marketing" },
  { label: "For miners", to: "/miners", group: "Marketing" },
  { label: "For maintainers", to: "/maintainers", group: "Marketing" },
  { label: "For coding agents", to: "/agents", group: "Marketing" },
  { label: "Overview", to: "/app", group: "App" },
  { label: "Miner command center", to: "/app/miner", group: "App" },
  { label: "Maintainer console", to: "/app/maintainer", group: "App" },
  { label: "Repo owner workspace", to: "/app/owner", group: "App" },
  { label: "Agent runs", to: "/app/runs", group: "App" },
  { label: "Agent playground", to: "/app/playground", group: "App" },
  { label: "@gittensory command simulator", to: "/app/commands", group: "App" },
  { label: "Product analytics", to: "/app/analytics", group: "App" },
  { label: "Maintainer digest", to: "/app/digest", group: "App" },
  { label: "Skipped PR audit", to: "/app/audit", group: "App" },
  { label: "Operator dashboard", to: "/app/operator", group: "App" },
  { label: "Beta onboarding", to: "/docs/beta-onboarding", group: "Docs" },
  { label: "Quickstart", to: "/docs/quickstart", group: "Docs" },
  { label: "MCP clients", to: "/docs/mcp-clients", group: "Docs" },
  { label: "Miner workflow", to: "/docs/miner-workflow", group: "Docs" },
  { label: "Maintainer workflow", to: "/docs/maintainer-workflow", group: "Docs" },
  { label: "Self-host reviews", to: "/docs/maintainer-self-hosting", group: "Docs" },
  { label: "Self-host quickstart", to: "/docs/self-hosting-quickstart", group: "Docs" },
  { label: "Self-host configuration", to: "/docs/self-hosting-configuration", group: "Docs" },
  { label: "Self-host GitHub App and Orb", to: "/docs/self-hosting-github-app", group: "Docs" },
  { label: "Self-host AI providers", to: "/docs/self-hosting-ai-providers", group: "Docs" },
  { label: "Self-host REES", to: "/docs/self-hosting-rees", group: "Docs" },
  { label: "REES analyzer reference", to: "/docs/self-hosting-rees-analyzers", group: "Docs" },
  { label: "Self-host RAG", to: "/docs/self-hosting-rag", group: "Docs" },
  { label: "Self-host operations", to: "/docs/self-hosting-operations", group: "Docs" },
  { label: "Self-host backup and scaling", to: "/docs/self-hosting-backup-scaling", group: "Docs" },
  { label: "Self-host releases", to: "/docs/self-hosting-releases", group: "Docs" },
  { label: "Self-host security", to: "/docs/self-hosting-security", group: "Docs" },
  { label: "Self-host troubleshooting", to: "/docs/self-hosting-troubleshooting", group: "Docs" },
  { label: "Branch analysis", to: "/docs/branch-analysis", group: "Docs" },
  { label: "Scoreability", to: "/docs/scoreability", group: "Docs" },
  { label: "Upstream drift", to: "/docs/upstream-drift", group: "Docs" },
  { label: "AI summaries policy", to: "/docs/ai-summaries", group: "Docs" },
  { label: "Privacy & security", to: "/docs/privacy-security", group: "Docs" },
  { label: "Troubleshooting", to: "/docs/troubleshooting", group: "Docs" },
  { label: "API reference", to: "/api", group: "Reference" },
  { label: "Browser extension", to: "/extension", group: "Reference" },
  { label: "Changelog", to: "/changelog", group: "Reference" },
  { label: "Roadmap", to: "/roadmap", group: "Reference" },
];

export function CommandPalette({ items = DEFAULT_ITEMS }: { items?: PaletteItem[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((i) => `${i.label} ${i.group ?? ""}`.toLowerCase().includes(term));
  }, [q, items]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-8 items-center gap-1.5 whitespace-nowrap rounded-token border border-border bg-transparent px-2.5 text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-strong md:inline-flex focus-ring"
        aria-label="Open command palette"
      >
        <Command className="size-3" />
        <span className="hidden xl:inline">Jump to…</span>
        <kbd className="ml-0.5 rounded border border-border bg-background/60 px-1 font-mono text-token-2xs">
          ⌘K
        </kbd>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[60] flex items-start justify-center bg-background/70 p-4 pt-[12vh] "
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -10, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl overflow-hidden rounded-token border border-border bg-popover/95 shadow-2xl"
            >
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search the app…"
                className="w-full border-b border-border bg-transparent px-4 py-3 text-token-sm outline-none placeholder:text-muted-foreground"
              />
              <ul className="max-h-[60vh] overflow-auto p-2">
                {filtered.length === 0 && (
                  <li className="px-3 py-6 text-center text-token-sm text-muted-foreground">
                    No matches
                  </li>
                )}
                {filtered.map((i) => (
                  <li key={i.to}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        navigate({ to: i.to });
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-token px-3 py-2 text-left text-token-sm transition-colors",
                        "text-foreground/90 hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {i.group && (
                          <span className="rounded border border-border px-1.5 py-px font-mono text-token-2xs text-muted-foreground">
                            {i.group}
                          </span>
                        )}
                        {i.label}
                      </span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
