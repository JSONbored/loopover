import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Github, Star, GitFork, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch, notifyApiFailure, notifyApiRecovered } from "@/lib/api/request";

const REPO = "jsonbored/gittensory";
const CACHE_KEY = "gh-stats-jsonbored-gittensory";
const CACHE_TTL = 1000 * 60 * 10; // 10 min

type RepoStats = { stargazers_count: number; forks_count: number };
type Cached = { stats: RepoStats; ts: number };

/** Normalize a GitHub count field — mirrors the backend's `finiteCount` so malformed/negative values
 *  cannot render as odd compact numbers. */
function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function readCache(): Cached | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    return parsed?.stats ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(stats: RepoStats) {
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ stats, ts: Date.now() }));
  } catch {
    /* noop */
  }
}

async function fetchRepo(): Promise<RepoStats> {
  const result = await apiFetch<{ stargazers_count?: number; forks_count?: number }>(
    `${getApiOrigin()}/v1/public/github/repos/jsonbored/gittensory/stats`,
    {
      label: "GitHub stats",
      timeoutMs: 6000,
      silentStatus: true, // GitHub failures shouldn't poison the LoopOver API status pill
    },
  );
  if (result.ok) {
    const stats = {
      stargazers_count: finiteCount(result.data?.stargazers_count),
      forks_count: finiteCount(result.data?.forks_count),
    };
    writeCache(stats);
    return stats;
  }
  // Fallback: fetch directly from the GitHub API when the Worker proxy is unavailable (rate-limited, 503,
  // network error). GitHub sends Access-Control-Allow-Origin: * for public repo endpoints, and each browser
  // gets its own 60/hr unauthenticated budget — enough for this single chip. (#1754)
  const ghResponse = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!ghResponse.ok) {
    throw new Error(`${result.message}; direct GitHub fallback failed (${ghResponse.status})`);
  }
  const body = (await ghResponse.json()) as { stargazers_count?: number; forks_count?: number };
  const stats = {
    stargazers_count: finiteCount(body.stargazers_count),
    forks_count: finiteCount(body.forks_count),
  };
  writeCache(stats);
  return stats;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function GithubStatsChip({ className }: { className?: string }) {
  // Avoid SSR/CSR mismatch: only read sessionStorage after mount.
  const [mounted, setMounted] = useState(false);
  const [cached, setCached] = useState<Cached | null>(null);
  useEffect(() => {
    setCached(readCache());
    setMounted(true);
  }, []);

  const { data, isError, isFetching, isLoading, refetch } = useQuery({
    queryKey: ["gh-repo", REPO],
    queryFn: fetchRepo,
    staleTime: CACHE_TTL,
    retry: 1,
    enabled: mounted,
    initialData: cached?.stats,
    initialDataUpdatedAt: cached?.ts,
  });

  // Show a toast with Retry on failure; clear it on recovery.
  const wasError = useRef(false);
  useEffect(() => {
    if (!mounted) return;
    if (isError && !isFetching) {
      wasError.current = true;
      notifyApiFailure({
        label: "GitHub stats",
        kind: "network",
        message: "GitHub repo stats are unavailable.",
        retry: async () => {
          await refetch();
        },
      });
    } else if (!isError && wasError.current && data) {
      wasError.current = false;
      notifyApiRecovered("GitHub stats");
    }
  }, [isError, isFetching, data, mounted, refetch]);

  const refreshing = mounted && isFetching && !isLoading;
  const showError = mounted && isError && !data;
  const showLoading = !mounted || (isLoading && !cached);
  const showData = mounted && !!data;

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <a
        href={`https://github.com/${REPO}`}
        target="_blank"
        rel="noreferrer"
        aria-label={
          showData && data
            ? `${REPO} on GitHub, ${data.stargazers_count} stars, ${data.forks_count} forks${refreshing ? " (refreshing)" : ""}`
            : showError
              ? `${REPO} on GitHub (stats unavailable)`
              : `${REPO} on GitHub (loading stats)`
        }
        title={showError ? "GitHub API unavailable — click to open repo" : `${REPO} on GitHub`}
        aria-busy={showLoading || refreshing}
        className={cn(
          "group inline-flex h-7 items-center gap-1.5 rounded-token border-hairline px-2 text-token-2xs font-mono text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:border-strong hover:text-foreground focus-ring",
          showError && "opacity-80",
        )}
      >
        <Github className="size-3 shrink-0" aria-hidden />

        {/* Loading skeleton (also rendered during SSR for hydration parity) */}
        {showLoading && (
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="h-2 w-5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="hidden h-2 w-4 animate-pulse rounded bg-muted motion-reduce:animate-none md:inline-block" />
          </span>
        )}

        {/* Error fallback — keep the link, drop the numbers */}
        {showError && (
          <span className="font-sans text-token-2xs italic text-muted-foreground">unavailable</span>
        )}

        {/* Loaded (fresh or cached) */}
        {showData && data && (
          <>
            <span className="flex items-center gap-1 text-foreground">
              <Star
                className={cn(
                  "size-2.5 text-mint transition-transform duration-200 motion-reduce:transition-none",
                  "group-hover:scale-110 motion-reduce:group-hover:scale-100",
                )}
                aria-hidden
              />
              <span className="tabular-nums">{compact.format(data.stargazers_count)}</span>
            </span>
            <span className="hidden items-center gap-1 md:flex">
              <GitFork className="size-2.5 opacity-70" aria-hidden />
              <span className="tabular-nums">{compact.format(data.forks_count)}</span>
            </span>
            {refreshing && (
              <RefreshCw
                className="size-2.5 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
            )}
          </>
        )}
      </a>
      {showError && (
        <button
          type="button"
          aria-label="Retry GitHub stats"
          title="Retry GitHub stats"
          onClick={() => {
            toast("Retrying GitHub stats", {
              description: "If GitHub rate limits are clear, the stars and forks will update.",
            });
            void refetch();
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-token border-hairline text-muted-foreground transition-all duration-150 hover:border-strong hover:text-foreground focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]"
        >
          <RefreshCw className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}
