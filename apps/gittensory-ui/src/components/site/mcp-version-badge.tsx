import { useQuery } from "@tanstack/react-query";
import { Package, ExternalLink, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

import { cn } from "@/lib/utils";
import { apiFetch, notifyApiFailure, notifyApiRecovered } from "@/lib/api/request";

type NpmPackage = {
  "dist-tags": { latest: string };
  time: Record<string, string>;
  versions: Record<string, unknown>;
};

async function fetchNpm(): Promise<NpmPackage> {
  const result = await apiFetch<NpmPackage>(
    "https://registry.npmjs.org/@jsonbored/gittensory-mcp",
    { label: "MCP package version", timeoutMs: 6000, silentStatus: true },
  );
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

export function McpVersionBadge({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["npm", "@jsonbored/gittensory-mcp"],
    queryFn: fetchNpm,
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });

  const wasError = useRef(false);
  useEffect(() => {
    if (isError && !isFetching) {
      wasError.current = true;
      notifyApiFailure({
        label: "MCP package version",
        kind: "network",
        message: "Latest version from npm registry is unavailable.",
        retry: async () => {
          await refetch();
        },
      });
    } else if (!isError && wasError.current && data) {
      wasError.current = false;
      notifyApiRecovered("MCP package version");
    }
  }, [isError, isFetching, data, refetch]);

  const latest = data?.["dist-tags"].latest;
  const versions = data
    ? Object.keys(data.versions)
        .sort((a, b) => (data.time[b] ?? "").localeCompare(data.time[a] ?? ""))
        .slice(0, 6)
    : [];

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="group inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-token border border-border/80 bg-transparent px-2 text-token-2xs font-mono text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:border-foreground/30 hover:text-foreground focus-ring"
        aria-label="MCP package version"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-mint/60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-mint" />
        </span>
        <Package className="size-3 shrink-0 opacity-70" />
        <span>mcp</span>
        <span className="truncate text-foreground">
          {isLoading ? "…" : isError ? "offline" : `v${latest}`}
        </span>
        <ChevronDown
          className={`size-2.5 shrink-0 opacity-50 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && data && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-token border border-border bg-popover/95 shadow-2xl"
          >
            <div className="border-b border-border px-4 py-3">
              <div className="text-token-xs uppercase tracking-wider text-muted-foreground">
                npm package
              </div>
              <div className="mt-0.5 font-mono text-token-sm text-foreground">
                @jsonbored/gittensory-mcp
              </div>
            </div>
            <ul className="max-h-64 overflow-auto p-2 text-token-sm">
              {versions.map((v) => (
                <li key={v}>
                  <a
                    href={`https://www.npmjs.com/package/@jsonbored/gittensory-mcp/v/${v}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between rounded-token px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <span className="font-mono">
                      v{v}
                      {v === latest && (
                        <span className="ml-2 rounded bg-mint/15 px-1.5 py-0.5 text-token-2xs uppercase tracking-wider text-mint">
                          latest
                        </span>
                      )}
                    </span>
                    <span className="text-token-2xs">
                      {new Date(data.time[v] ?? "").toLocaleDateString()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <a
              href="https://www.npmjs.com/package/@jsonbored/gittensory-mcp"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between border-t border-border px-4 py-2.5 text-token-xs text-muted-foreground hover:text-foreground"
            >
              View on npm
              <ExternalLink className="size-3" />
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
