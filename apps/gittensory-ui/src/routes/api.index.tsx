import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";

import { CodeBlock, Callout, Eyebrow } from "@/components/site/primitives";
import { MethodPill, BoundaryBadge } from "@/components/site/control-primitives";
import { openapi } from "@/lib/openapi";
import {
  MCP_MINIMUM_SUPPORTED_VERSION,
  MCP_PACKAGE_NAME,
  getLatestMcpVersion,
  getMcpInstallCommand,
  useMcpPackageMetadata,
} from "@/lib/mcp-package";

export const Route = createFileRoute("/api/")({
  component: ApiOverview,
});

function ApiOverview() {
  const server = openapi.servers[0]?.url ?? "";
  const { data } = useMcpPackageMetadata();
  const latestMcpVersion = getLatestMcpVersion(data);
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 lg:px-10">
      <Eyebrow>API reference</Eyebrow>
      <h1 className="mt-3 text-token-2xl font-medium tracking-tight text-foreground">
        Gittensory API
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">{openapi.description.split("\n\n")[0]}</p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <BoundaryBadge boundary="private-api" />
        <span className="rounded-token border border-border bg-transparent px-2 py-1 font-mono text-token-2xs text-muted-foreground">
          {openapi.version}
        </span>
        <span className="rounded-token border border-border bg-transparent px-2 py-1 font-mono text-token-2xs text-muted-foreground">
          {server}
        </span>
      </div>

      <div className="mt-8 space-y-5">
        <Callout variant="safety">
          <strong>Auth.</strong> Use a Gittensory session token from{" "}
          <code>gittensory-mcp login</code>. Never paste a GitHub PAT. Tokens you use in this
          reference live only in <code>localStorage</code> on this device and can be cleared
          instantly.
        </Callout>

        <div className="rounded-token border border-border bg-transparent p-5">
          <div className="flex items-center gap-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="size-3.5 text-mint" />
            Public / private boundary
          </div>
          <p className="mt-2 text-token-sm text-muted-foreground">
            Endpoints carry an implicit boundary. Anything tagged <code>private-mcp</code> or{" "}
            <code>private-api</code> must never land in public GitHub output (comments, checks,
            labels). Public surfaces are sanitized server-side.
          </p>
        </div>

        <div className="rounded-token border border-border bg-transparent p-5">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            MCP version contract
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Current npm latest
              </dt>
              <dd className="mt-1 font-mono text-token-sm text-foreground">
                {MCP_PACKAGE_NAME} v{latestMcpVersion}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Minimum supported
              </dt>
              <dd className="mt-1 font-mono text-token-sm text-foreground">
                {MCP_MINIMUM_SUPPORTED_VERSION}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-token-sm text-muted-foreground">
            Use npm <code>dist-tags.latest</code> for current-version display.{" "}
            <code>/v1/mcp/compatibility</code> stays the API compatibility metadata source.
          </p>
          <CodeBlock className="mt-3" code={getMcpInstallCommand(latestMcpVersion)} />
        </div>

        <div>
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Quick example
          </div>
          <CodeBlock lang="bash" className="mt-2" code={`curl '${server}/health'`} />
        </div>
      </div>

      <div className="mt-12">
        <h2 className="font-display text-token-lg font-semibold">Endpoints</h2>
        <div className="mt-3 space-y-6">
          {openapi.tags.map((g) => (
            <div key={g.name}>
              <div className="mb-1 flex items-baseline gap-2">
                <h3 className="font-display text-token-sm font-semibold text-foreground">
                  {g.name}
                </h3>
                {g.description && (
                  <span className="text-token-xs text-muted-foreground">{g.description}</span>
                )}
              </div>
              <ul className="divide-y divide-border/50 rounded-token border border-border">
                {g.operations.map((op) => (
                  <li key={op.id}>
                    <Link
                      to="/api/$op"
                      params={{ op: op.id }}
                      className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40"
                    >
                      <MethodPill method={op.method} />
                      <span className="truncate font-mono text-[12px] text-foreground/90">
                        {op.path}
                      </span>
                      <span className="ml-auto hidden truncate text-token-xs text-muted-foreground sm:inline">
                        {op.summary}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
