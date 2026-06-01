import { createFileRoute, notFound, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";

import { CodeBlock, Callout } from "@/components/site/primitives";
import { MethodPill, StatusPill, BoundaryBadge } from "@/components/site/control-primitives";
import { TryIt } from "@/components/site/api/try-it";
import {
  findOperation,
  generateCurl,
  generateFetch,
  generatePython,
  openapi,
  type OpenApiOperation,
} from "@/lib/openapi";

type Sample = "curl" | "ts" | "python";

export const Route = createFileRoute("/api/$op")({
  loader: ({ params }) => {
    const op = findOperation(params.op);
    if (!op) throw notFound();
    return op;
  },
  head: ({ loaderData }) => {
    const op = loaderData;
    if (!op) return { meta: [{ title: "Endpoint — Gittensory API" }] };
    return {
      meta: [
        { title: `${op.method.toUpperCase()} ${op.path} — Gittensory API` },
        { name: "description", content: op.summary },
        { property: "og:title", content: `${op.method.toUpperCase()} ${op.path}` },
      ],
    };
  },
  component: OperationPage,
});

function OperationPage() {
  const op = Route.useLoaderData() as OpenApiOperation;
  const server = openapi.servers[0]?.url ?? "";
  const [sample, setSample] = useState<Sample>("curl");
  const navigate = useNavigate();

  const ops = openapi.operations;
  const idx = ops.findIndex((o) => o.id === op.id);
  const prev = idx > 0 ? ops[idx - 1] : null;
  const next = idx < ops.length - 1 ? ops[idx + 1] : null;

  // Siblings within the same tag, for the in-tag chips.
  const tagSiblings = useMemo(() => ops.filter((o) => o.tag === op.tag), [ops, op.tag]);
  // Distinct tag groups, in declaration order, for the cross-section chips.
  const tagGroups = useMemo(() => {
    const seen = new Set<string>();
    const out: { tag: string; first: OpenApiOperation }[] = [];
    for (const o of ops) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      out.push({ tag: o.tag, first: o });
    }
    return out;
  }, [ops]);

  // Roving tabindex across the sticky chip toolbar. Only the focused chip
  // is tab-reachable; arrow keys move focus between siblings.
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const focusChip = (delta: number) => {
    const root = chipsRef.current;
    if (!root) return;
    const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-chip="1"]'));
    if (chips.length === 0) return;
    const activeIdx = chips.findIndex((c) => c === document.activeElement);
    const start = activeIdx === -1 ? 0 : activeIdx;
    const nextIdx = (start + delta + chips.length) % chips.length;
    chips.forEach((c, i) => c.setAttribute("tabindex", i === nextIdx ? "0" : "-1"));
    chips[nextIdx].focus();
  };

  const onStickyKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Arrow keys: move focus along the chip toolbar (do not navigate routes).
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      focusChip(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const root = chipsRef.current;
      if (!root) return;
      const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-chip="1"]'));
      if (chips.length === 0) return;
      const target = e.key === "Home" ? chips[0] : chips[chips.length - 1];
      chips.forEach((c) => c.setAttribute("tabindex", c === target ? "0" : "-1"));
      target.focus();
      return;
    }
    // [ and ] jump to adjacent tag sections (route change).
    if (e.key === "[" || e.key === "]") {
      const i = tagGroups.findIndex((g) => g.tag === op.tag);
      const target = e.key === "[" ? tagGroups[i - 1] : tagGroups[i + 1];
      if (target) {
        e.preventDefault();
        navigate({ to: "/api/$op", params: { op: target.first.id } });
      }
      return;
    }
    // Enter/Space activate the focused chip — Link handles by default; no-op here.
    // Plain prev/next sibling jump via < / > shifts (shifted keys).
    if (e.shiftKey && (e.key === "<" || e.key === ",") && prev) {
      e.preventDefault();
      navigate({ to: "/api/$op", params: { op: prev.id } });
    } else if (e.shiftKey && (e.key === ">" || e.key === ".") && next) {
      e.preventDefault();
      navigate({ to: "/api/$op", params: { op: next.id } });
    }
  };

  const code =
    sample === "curl"
      ? generateCurl(op, server)
      : sample === "ts"
        ? generateFetch(op, server)
        : generatePython(op, server);

  const exampleResponse = Object.entries(op.responses).find(
    ([, r]) => (r as { example?: unknown }).example !== undefined,
  ) as [string, { description?: string; example?: unknown }] | undefined;

  return (
    <div className="grid grid-cols-1 gap-10 px-6 py-10 lg:px-10 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-12">
      <article className="min-w-0">
        {/* Sticky operation header — method/path + jump chips. Arrow keys to move
            between siblings; [ ] to move between tag sections. */}
        <nav
          aria-label="Operation navigation"
          onKeyDown={onStickyKeyDown}
          className="sticky top-14 z-20 -mx-6 mb-5 space-y-2 border-b border-border bg-background/85 px-6 py-2 backdrop-blur lg:-mx-10 lg:px-10"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <MethodPill method={op.method} />
            <code className="min-w-0 flex-1 truncate font-mono text-token-sm text-foreground/90">
              {op.path}
            </code>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <BoundaryBadge boundary={op.requiresAuth ? "private-api" : "public"} />
              {op.requiresAuth && (
                <StatusPill status="info" className="hidden md:inline-flex">
                  <Lock className="size-3" /> Bearer
                </StatusPill>
              )}
            </span>
          </div>
          {/* Tag-group chips */}
          <div
            ref={chipsRef}
            role="toolbar"
            aria-label="Jump between API sections"
            className="scrollbar-none flex items-center gap-1 overflow-x-auto"
          >
            {tagGroups.map((g) => {
              const active = g.tag === op.tag;
              return (
                <Link
                  key={g.tag}
                  to="/api/$op"
                  params={{ op: g.first.id }}
                  data-chip="1"
                  tabIndex={active ? 0 : -1}
                  aria-current={active ? "page" : undefined}
                  className={
                    "shrink-0 rounded-token border px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider transition-colors duration-150 motion-reduce:transition-none focus-ring " +
                    (active
                      ? "border-mint/40 bg-mint/10 text-mint"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-strong")
                  }
                >
                  {g.tag}
                </Link>
              );
            })}
            <span className="mx-1 hidden accent-divider-v sm:inline-block" aria-hidden />
            {/* Sibling op chips within current tag */}
            <div className="hidden items-center gap-1 sm:flex">
              {tagSiblings.map((s) => {
                const active = s.id === op.id;
                return (
                  <Link
                    key={s.id}
                    to="/api/$op"
                    params={{ op: s.id }}
                    title={s.summary}
                    data-chip="1"
                    tabIndex={-1}
                    aria-label={`${s.method.toUpperCase()} ${s.path} — ${s.summary}`}
                    className={
                      "inline-flex shrink-0 items-center gap-1 rounded-token border px-1.5 py-0.5 transition-colors duration-150 motion-reduce:transition-none focus-ring " +
                      (active
                        ? "border-mint/40 bg-mint/5"
                        : "border-transparent hover:border-border")
                    }
                  >
                    <MethodPill method={s.method} className="!min-w-[36px] !text-[10px]" />
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>
        <nav className="mb-4 flex items-center gap-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          <Link to="/api" className="hover:text-foreground">
            API
          </Link>
          <span>/</span>
          <span className="text-foreground/70">{op.tag}</span>
        </nav>
        <h1 className="text-token-xl font-medium tracking-tight text-foreground">{op.summary}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <BoundaryBadge boundary={op.requiresAuth ? "private-api" : "public"} />
          {op.requiresAuth && (
            <StatusPill status="info">
              <Lock className="size-3" /> Requires bearer
            </StatusPill>
          )}
        </div>
        {op.description && (
          <div className="prose prose-invert mt-5 max-w-none text-token-base leading-token-relaxed text-muted-foreground">
            {op.description.split("\n\n").map((p, i) => (
              <p
                key={i}
                className="my-3 whitespace-pre-line [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-foreground"
              >
                {renderInline(p)}
              </p>
            ))}
          </div>
        )}

        {op.parameters.length > 0 && (
          <section className="mt-8">
            <h2 className="font-display text-token-base font-semibold">Parameters</h2>
            <div className="mt-3 overflow-hidden rounded-token border border-border">
              <table className="w-full text-token-sm">
                <thead className="border-b border-border bg-transparent text-left font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">In</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {op.parameters.map((p) => (
                    <tr key={p.name} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-[12px] text-foreground/90">
                        {p.name}
                        {p.required && <span className="text-danger">*</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-token-2xs text-muted-foreground">
                        {p.in}
                      </td>
                      <td className="px-3 py-2 font-mono text-token-2xs text-muted-foreground">
                        {p.schema?.type ?? "string"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{p.description ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="mt-8">
          <h2 className="font-display text-token-base font-semibold">Responses</h2>
          <ul className="mt-3 space-y-2">
            {(Object.entries(op.responses) as Array<[string, { description?: string }]>).map(
              ([code, r]) => (
                <li
                  key={code}
                  className="flex items-start gap-3 rounded-token border border-border bg-transparent p-3"
                >
                  <StatusPill
                    status={Number(code) < 400 ? "ok" : Number(code) < 500 ? "warn" : "blocked"}
                  >
                    {code}
                  </StatusPill>
                  <div className="text-token-sm text-muted-foreground">{r.description ?? "—"}</div>
                </li>
              ),
            )}
          </ul>
          {exampleResponse && (
            <div className="mt-3">
              <div className="mb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Example response · {exampleResponse[0]}
              </div>
              <CodeBlock lang="json" code={JSON.stringify(exampleResponse[1].example, null, 2)} />
            </div>
          )}
        </section>

        <div className="mt-12 flex items-center justify-between border-t border-border pt-6">
          {prev ? (
            <Link
              to="/api/$op"
              params={{ op: prev.id }}
              className="inline-flex items-center gap-2 text-token-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> {prev.summary}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              to="/api/$op"
              params={{ op: next.id }}
              className="inline-flex items-center gap-2 text-token-sm text-muted-foreground hover:text-foreground"
            >
              {next.summary} <ArrowRight className="size-3.5" />
            </Link>
          ) : (
            <span />
          )}
        </div>
      </article>

      <aside className="space-y-6 xl:sticky xl:top-20 xl:self-start">
        <div className="overflow-hidden rounded-token border border-border bg-transparent">
          <div className="flex border-b border-border bg-transparent font-mono text-token-2xs uppercase tracking-wider">
            {(["curl", "ts", "python"] as Sample[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSample(s)}
                aria-pressed={sample === s}
                className={
                  "px-3 py-2 transition-colors duration-150 motion-reduce:transition-none focus-ring " +
                  (sample === s
                    ? "text-foreground border-b border-mint"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {s === "ts" ? "fetch" : s}
              </button>
            ))}
          </div>
          <pre className="scrollbar-none overflow-x-auto p-4 font-mono text-[12px] leading-token-relaxed text-foreground/90">
            <code>{code}</code>
          </pre>
        </div>

        <div className="rounded-token border border-border bg-transparent p-4">
          <div className="mb-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Try it
          </div>
          <TryIt op={op} server={server} />
        </div>

        {!op.requiresAuth && (
          <Callout>This endpoint is unauthenticated and safe to call from anywhere.</Callout>
        )}
      </aside>
    </div>
  );
}

// Minimal inline renderer: turns `code` spans into <code> elements without pulling MDX/markdown libs.
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return <code key={i}>{p.slice(1, -1)}</code>;
    }
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="text-foreground">
          {p.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
