import { createFileRoute } from "@tanstack/react-router";
import { Rss } from "lucide-react";

import { Section, Eyebrow, Card } from "@/components/site/primitives";
import { cn } from "@/lib/utils";
import {
  MCP_PACKAGE_NAME,
  MCP_PACKAGE_NPM_URL,
  getLatestMcpVersion,
  useMcpPackageMetadata,
} from "@/lib/mcp-package";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: [
      { title: "Changelog — Gittensory" },
      {
        name: "description",
        content: "Release history for @jsonbored/gittensory-mcp pulled live from the npm registry.",
      },
      { property: "og:title", content: "Changelog — Gittensory" },
      {
        property: "og:description",
        content: "Release history for @jsonbored/gittensory-mcp pulled live from the npm registry.",
      },
      { property: "og:url", content: "/changelog" },
    ],
    links: [{ rel: "canonical", href: "/changelog" }],
  }),
  component: Changelog,
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function Changelog() {
  const { data, isLoading, isError } = useMcpPackageMetadata();
  const latestVersion = getLatestMcpVersion(data);

  const sortedVersions = data
    ? Object.keys(data.versions)
        .filter((v) => data.time[v])
        .sort((a, b) => data.time[b].localeCompare(data.time[a]))
    : [];

  const years = Array.from(
    new Set(sortedVersions.map((v) => new Date(data?.time[v] ?? "").getFullYear().toString())),
  ).filter((y) => y !== "NaN");

  return (
    <Section className="pt-16 pb-24 sm:pt-24">
      <Eyebrow>Releases</Eyebrow>
      <h1 className="mt-3 text-token-2xl font-medium tracking-tight text-foreground">Changelog</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Live release history for <code className="font-mono">{MCP_PACKAGE_NAME}</code>, sourced
        directly from npm <code className="font-mono">dist-tags.latest</code>. Current release:{" "}
        <code className="font-mono">v{latestVersion}</code>.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href={MCP_PACKAGE_NPM_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-token border-hairline px-2.5 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-mint hover:border-strong focus-ring"
        >
          <Rss className="size-3" aria-hidden /> npm package
        </a>
        <a
          href="https://github.com/jsonbored/gittensory/releases"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-token border-hairline px-2.5 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-mint hover:border-strong focus-ring"
        >
          GitHub releases →
        </a>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_200px]">
        <div className="space-y-4">
          {isLoading && (
            <div className="text-token-sm text-muted-foreground">Loading from npm…</div>
          )}
          {isError && (
            <Card>
              <div className="text-token-sm text-muted-foreground">
                Could not reach the npm registry. Try again later.
              </div>
            </Card>
          )}
          {sortedVersions.map((v) => {
            const isLatest = v === latestVersion;
            const id = `v${v.replace(/\./g, "-")}`;
            return (
              <Card
                key={v}
                className={cn(
                  "scroll-mt-20 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
                )}
              >
                <div id={id}>
                  <div className="flex items-center gap-2">
                    <a
                      href={`#${id}`}
                      className="font-mono text-token-lg text-foreground transition-colors hover:text-mint"
                    >
                      v{v}
                    </a>
                    {isLatest && (
                      <span className="rounded bg-mint/15 px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
                        latest
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-token-xs text-muted-foreground">
                    Published {formatDate(data?.time[v])}
                  </div>
                </div>
                <a
                  href={`${MCP_PACKAGE_NPM_URL}/v/${v}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-token-sm font-medium text-mint hover:underline"
                >
                  View on npm →
                </a>
              </Card>
            );
          })}
        </div>

        {sortedVersions.length > 0 && (
          <aside className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-auto">
            {years.length > 1 && (
              <>
                <div className="mb-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                  Year
                </div>
                <ul className="mb-5 flex flex-wrap gap-1.5">
                  {years.map((y) => (
                    <li key={y}>
                      <a
                        href={`#year-${y}`}
                        className="inline-flex rounded-token border-hairline px-2 py-0.5 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:text-mint hover:border-strong focus-ring"
                      >
                        {y}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mb-3 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              Versions
            </div>
            <ul className="space-y-1 border-l border-border">
              {sortedVersions.map((v) => {
                const id = `v${v.replace(/\./g, "-")}`;
                const isLatest = v === latestVersion;
                return (
                  <li key={v}>
                    <a
                      href={`#${id}`}
                      className="-ml-px block border-l border-transparent py-0.5 pl-3 text-token-sm text-muted-foreground transition-colors hover:border-mint hover:text-mint"
                    >
                      v{v}
                      {isLatest && (
                        <span className="ml-2 font-mono text-token-2xs uppercase tracking-wider text-mint">
                          latest
                        </span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>
    </Section>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return DATE_FORMATTER.format(date);
}
