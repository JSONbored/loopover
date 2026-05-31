import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface MirroredStep {
  title: string;
  miner: ReactNode;
  maintainer: ReactNode;
  nextStep?: {
    miner?: { label: string; to: string };
    maintainer?: { label: string; to: string };
  };
}

/**
 * Side-by-side, role-mirrored workflow layout used by the miner and
 * maintainer docs. Each step shows what the miner does and what the
 * maintainer sees at the same point in the loop. The `role` prop
 * controls which column is emphasized.
 */
export function WorkflowMirror({
  role,
  steps,
  minerCta,
  maintainerCta,
}: {
  role: "miner" | "maintainer";
  steps: MirroredStep[];
  minerCta: { label: string; to: string };
  maintainerCta: { label: string; to: string };
}) {
  const minerActive = role === "miner";
  return (
    <div className="not-prose mt-6 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Header eyebrow="Miner" title="What the contributor does" active={minerActive} />
        <Header eyebrow="Maintainer" title="What the repo owner sees" active={!minerActive} />
      </div>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="grid gap-3 rounded-token border border-border bg-transparent p-4 sm:grid-cols-[auto_1fr_1fr] sm:items-start sm:gap-4"
          >
            <span
              aria-hidden
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-token-2xs text-muted-foreground"
            >
              {i + 1}
            </span>
            <Cell active={minerActive} title={s.title} nextStep={s.nextStep?.miner}>
              {s.miner}
            </Cell>
            <Cell active={!minerActive} title={s.title} nextStep={s.nextStep?.maintainer}>
              {s.maintainer}
            </Cell>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <Cta cta={minerCta} active={minerActive} />
        <Cta cta={maintainerCta} active={!minerActive} />
      </div>
    </div>
  );
}

function Header({ eyebrow, title, active }: { eyebrow: string; title: string; active: boolean }) {
  return (
    <div
      className={cn(
        "rounded-token border px-3 py-2",
        active ? "border-mint/40 bg-mint/5" : "border-border bg-transparent text-muted-foreground",
      )}
    >
      <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {eyebrow}
      </div>
      <div className={cn("mt-0.5 text-token-sm", active && "text-foreground")}>{title}</div>
    </div>
  );
}

function Cell({
  active,
  title,
  children,
  nextStep,
}: {
  active: boolean;
  title: string;
  children: ReactNode;
  nextStep?: { label: string; to: string };
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-token px-3 py-2 text-token-sm",
        active ? "bg-mint/5 text-foreground/90" : "text-muted-foreground/85",
      )}
    >
      <div className="sr-only">{title}</div>
      {children}
      {nextStep && (
        <Link
          to={nextStep.to}
          className={cn(
            "group/next mt-2 inline-flex items-center gap-1 text-token-xs transition-colors duration-150 motion-reduce:transition-none focus-ring rounded-token",
            active
              ? "text-mint hover:text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span>{nextStep.label}</span>
          <ArrowRight
            className="size-3 transition-transform duration-150 group-hover/next:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover/next:translate-x-0"
            aria-hidden
          />
        </Link>
      )}
    </div>
  );
}

function Cta({ cta, active }: { cta: { label: string; to: string }; active: boolean }) {
  return (
    <Link
      to={cta.to}
      className={cn(
        "group inline-flex items-center justify-between gap-3 rounded-token border px-3 py-2 text-token-sm transition-colors duration-150 focus-ring motion-reduce:transition-none",
        active
          ? "border-mint/40 bg-mint/10 text-foreground hover:bg-mint/15"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40",
      )}
    >
      <span>{cta.label}</span>
      <ArrowRight
        className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        aria-hidden
      />
    </Link>
  );
}
