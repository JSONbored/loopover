const NOISY = [
  { name: "lint / eslint", status: "fail" },
  { name: "ci / unit", status: "fail" },
  { name: "ci / integration", status: "pending" },
  { name: "gittensor-scorer / preview", status: "fail" },
  { name: "gittensor-scorer / blockers", status: "warn" },
  { name: "subnet-bot / advisory", status: "fail" },
  { name: "subnet-bot / nudge", status: "warn" },
] as const;

const QUIET = [
  { name: "lint / eslint", status: "pass" },
  { name: "ci / unit", status: "pass" },
] as const;

export function PrQuietCompare() {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <Panel label="Before — generic mining bot">
        <ul className="divide-y divide-border border-t border-border">
          {NOISY.map((c) => (
            <Row key={c.name} {...c} />
          ))}
        </ul>
        <CommentBlock
          author="some-mining-bot"
          body="Score: 0.42 (gated). Blockers: unsquashed-commits, missing-issue-link. Estimated reward: 0.0031 TAO."
          variant="loud"
        />
      </Panel>
      <Panel label="After — LoopOver">
        <ul className="divide-y divide-border border-t border-border">
          {QUIET.map((c) => (
            <Row key={c.name} {...c} />
          ))}
        </ul>
        <CommentBlock
          author="gittensory[bot]"
          body="Confirmed miner. Preflight: ready. One linked issue · one squashed commit. Maintainer packet available on request."
          variant="quiet"
        />
        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-token border border-coral/40 bg-coral/10 px-2 py-0.5 font-mono text-token-2xs text-coral">
            gittensor:confirmed-miner
          </span>
        </div>
      </Panel>
    </div>
  );
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-token border border-border bg-background p-4">
      <div className="text-token-2xs text-muted-foreground">{label}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Row({ name, status }: { name: string; status: string }) {
  const dot =
    status === "fail"
      ? "bg-danger"
      : status === "warn"
        ? "bg-warning"
        : status === "pending"
          ? "bg-muted-foreground"
          : "bg-success";
  return (
    <li className="flex items-center justify-between py-2 text-token-xs">
      <span className="flex items-center gap-2 text-foreground/80">
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        <span className="font-mono">{name}</span>
      </span>
      <span className="font-mono uppercase tracking-wider text-muted-foreground">{status}</span>
    </li>
  );
}

function CommentBlock({
  author,
  body,
  variant,
}: {
  author: string;
  body: string;
  variant: "loud" | "quiet";
}) {
  return (
    <div
      className={
        "mt-4 rounded-token border p-3 " +
        (variant === "loud" ? "border-danger/30" : "border-border")
      }
    >
      <div className="font-mono text-token-2xs text-muted-foreground">{author}</div>
      <p className="mt-1 text-token-sm text-foreground/85">{body}</p>
    </div>
  );
}
