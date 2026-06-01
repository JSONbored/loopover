import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-20 sm:py-24", className)}
    >
      {children}
    </section>
  );
}

/**
 * Single source-of-truth layout primitives.
 * Marketing/docs/api routes → PageFrame (max-w-6xl).
 * App routes → AppFrame (full-bleed, denser).
 */
export function PageFrame({
  className,
  children,
  as: As = "div",
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "main" | "section";
}) {
  return (
    <As className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)}>{children}</As>
  );
}

export function AppFrame({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("w-full px-4 sm:px-6 lg:px-8 py-6", className)}>{children}</div>;
}

export function Prose({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-3xl", className)}>{children}</div>;
}

export function SetPiece({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-5xl", className)}>{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0 space-y-2">
        {eyebrow && (
          <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
            {eyebrow}
          </div>
        )}
        <h1 className="font-display text-token-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-token-sm text-muted-foreground leading-token-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-token border-hairline bg-card p-4 transition-colors hover:border-strong",
        className,
      )}
    >
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 font-display text-token-2xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      {hint && <div className="mt-1 text-token-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-token border-hairline bg-card/40 p-10 text-center",
        className,
      )}
    >
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="text-token-sm font-medium text-foreground">{title}</div>
      {description && <p className="max-w-sm text-token-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Eyebrow({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-token-xs",
        accent ? "text-mint" : "text-muted-foreground",
      )}
    >
      {accent && <span aria-hidden className="size-1 rounded-full bg-mint" />}
      {children}
    </div>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="max-w-2xl">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="mt-2 text-token-xl font-medium tracking-tight text-foreground">{title}</h2>
      {description && <p className="mt-2 text-token-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-token border border-border p-5 transition-colors hover:border-foreground/20",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CodeBlock({
  code,
  lang,
  filename,
  className,
}: {
  code: string;
  lang?: string;
  filename?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Code copied", { description: "The snippet is ready to paste." });
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Copy failed", { description: "Select the snippet and copy it manually." });
    }
  };
  return (
    <div className={cn("group", className)}>
      {filename && (
        <div className="mb-1.5 font-mono text-token-2xs text-muted-foreground">{filename}</div>
      )}
      <div className="relative rounded-token border border-border bg-background">
        <pre className="scrollbar-none overflow-x-auto p-4 text-token-xs leading-token-relaxed">
          <code className="font-mono text-foreground/90">{code}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-token text-muted-foreground opacity-45 transition-all duration-150 hover:bg-accent hover:text-foreground hover:opacity-100 group-hover:opacity-100 focus:opacity-100 focus-ring motion-reduce:transition-none"
        >
          {copied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
        </button>
        {lang && !filename && (
          <span className="pointer-events-none absolute bottom-1.5 right-2 font-mono text-token-2xs text-muted-foreground opacity-60">
            {lang}
          </span>
        )}
      </div>
    </div>
  );
}

export function Callout({
  variant = "note",
  title,
  children,
}: {
  variant?: "note" | "safety" | "warn";
  title?: string;
  children: ReactNode;
}) {
  const border =
    variant === "safety"
      ? "border-l-mint"
      : variant === "warn"
        ? "border-l-warning"
        : "border-l-border";
  return (
    <div className={cn("rounded-token border border-border border-l-2 p-4 text-token-sm", border)}>
      {title && <div className="mb-1 text-token-xs font-medium text-foreground">{title}</div>}
      <div className="text-muted-foreground [&_strong]:text-foreground">{children}</div>
    </div>
  );
}

export function FeatureRow({
  items,
}: {
  items: Array<{ icon?: ReactNode; title: string; description: string }>;
}) {
  return (
    <dl className="divide-y divide-border border-y border-border">
      {items.map((it) => (
        <div key={it.title} className="grid gap-2 py-4 sm:grid-cols-[14rem_1fr] sm:gap-8">
          <dt className="text-token-sm font-medium text-foreground">{it.title}</dt>
          <dd className="text-token-sm text-muted-foreground">{it.description}</dd>
        </div>
      ))}
    </dl>
  );
}
