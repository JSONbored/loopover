import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { GitPullRequestArrow, MessageSquare } from "lucide-react";

import { StatusPill } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { useApiResource } from "@/lib/api/use-api-resource";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type CommandSample = {
  id: string;
  command: string;
  audience: string;
  boundary: "public" | "private-api" | "private-mcp";
  description: string;
  endpoint: string;
};

type CommandsResponse = {
  commands: CommandSample[];
};

type CommandPreviewResponse = {
  preview: {
    boundary: CommandSample["boundary"];
    body: string;
  };
};

export function CommandsPanel() {
  const commands = useApiResource<CommandsResponse>("/v1/app/commands", "Command catalog");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [repoFullName, setRepoFullName] = useState("");
  const [pullNumber, setPullNumber] = useState("");
  const [preview, setPreview] = useState<CommandPreviewResponse | null>(null);
  const selected =
    commands.status === "ready"
      ? (commands.data.commands.find((command) => command.id === selectedId) ??
        commands.data.commands[0])
      : null;
  const parsedPullNumber = Number(pullNumber);
  const validContext =
    /^[^/\s]+\/[^/\s]+$/.test(repoFullName.trim()) &&
    Number.isInteger(parsedPullNumber) &&
    parsedPullNumber > 0;

  useEffect(() => {
    setPreview(null);
    if (!selected || !validContext) return;
    let active = true;
    const origin = getApiOrigin().replace(/\/$/, "");
    void apiFetch<CommandPreviewResponse>(`${origin}/v1/app/commands/preview`, {
      method: "POST",
      label: "Command preview",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        command: selected.id,
        repoFullName: repoFullName.trim(),
        pullNumber: parsedPullNumber,
      }),
      silentStatus: true,
    }).then((result) => {
      if (active && result.ok) setPreview(result.data);
    });
    return () => {
      active = false;
    };
  }, [parsedPullNumber, repoFullName, selected, validContext]);

  return (
    <StateBoundary
      isLoading={commands.status === "loading"}
      isError={commands.status === "error"}
      isEmpty={commands.status === "ready" && commands.data.commands.length === 0}
      onRetry={commands.reload}
      onRefresh={commands.reload}
      loadingTitle="Loading command catalog…"
      emptyTitle="No commands available"
      emptyDescription="Maintainer command previews appear after the API command catalog is available."
      errorDescription={commands.status === "error" ? commands.error : undefined}
    >
      {commands.status === "ready" && selected ? (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-token border-hairline bg-card p-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <label className="block">
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Repository
              </span>
              <Input
                value={repoFullName}
                onChange={(event) => setRepoFullName(event.target.value)}
                placeholder="owner/repo"
                className="mt-1 font-mono text-token-xs"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Pull request
              </span>
              <Input
                value={pullNumber}
                onChange={(event) => setPullNumber(event.target.value)}
                placeholder="123"
                inputMode="numeric"
                className="mt-1 font-mono text-token-xs"
              />
            </label>
          </div>

          <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
            <ul className="space-y-2">
              {commands.data.commands.map((command) => {
                const active = command.id === selected.id;
                return (
                  <li key={command.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(command.id)}
                      className={cn(
                        "w-full rounded-token border-hairline p-3 text-left transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.99]",
                        active
                          ? "border-strong bg-mint/[0.04]"
                          : "hover:border-strong hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-token-xs text-foreground">
                          {command.command}
                        </span>
                        <StatusPill status={command.boundary === "public" ? "ready" : "info"}>
                          {command.audience}
                        </StatusPill>
                      </div>
                      <p className="mt-1 text-token-xs text-muted-foreground">
                        {command.description}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            <PrThread
              sample={selected}
              preview={preview?.preview ?? null}
              repoFullName={repoFullName.trim()}
              pullNumber={validContext ? parsedPullNumber : null}
            />
          </div>
        </div>
      ) : null}
    </StateBoundary>
  );
}

function PrThread({
  sample,
  preview,
  repoFullName,
  pullNumber,
}: {
  sample: CommandSample;
  preview: CommandPreviewResponse["preview"] | null;
  repoFullName: string;
  pullNumber: number | null;
}) {
  const hasContext = Boolean(repoFullName && pullNumber);
  return (
    <div className="overflow-hidden rounded-token border-hairline bg-card">
      <div className="flex items-center gap-2 border-b-hairline bg-background/40 px-4 py-2.5">
        <GitPullRequestArrow className="size-4 text-mint" />
        <div className="font-mono text-token-xs text-foreground/90">
          {hasContext ? repoFullName : "Enter repo context"}{" "}
          <span className="text-muted-foreground">·</span>{" "}
          {pullNumber ? `PR #${pullNumber}` : "PR #"}
        </div>
        <span className="ml-auto rounded-full border-hairline bg-mint/10 px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
          private preview
        </span>
      </div>

      <div className="space-y-4 p-4">
        {hasContext ? (
          <Comment author="maintainer" body={sample.command} muted />
        ) : (
          <div className="rounded-token border-hairline bg-background/40 p-3 text-token-xs text-muted-foreground">
            Enter a repository and pull request number to preview this command against live API
            context.
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={sample.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
          >
            <BotReply
              boundary={preview?.boundary ?? sample.boundary}
              body={preview?.body ?? sample.description}
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Comment({ author, body, muted }: { author: string; body: string; muted?: boolean }) {
  return (
    <div className="rounded-token border-hairline bg-background/40 p-3">
      <div className="mb-1 flex items-center gap-2 text-token-xs">
        <MessageSquare className="size-3 text-muted-foreground" />
        <span className={cn("font-mono", muted ? "text-muted-foreground" : "text-foreground")}>
          {author}
        </span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-token-xs text-foreground/90">{body}</pre>
    </div>
  );
}

function BotReply({ boundary, body }: { boundary: CommandSample["boundary"]; body: string }) {
  const isPrivate = boundary !== "public";
  return (
    <div
      className={cn(
        "rounded-token border-hairline p-3",
        isPrivate ? "bg-mint/[0.04]" : "bg-success/[0.04]",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-token text-token-2xs font-bold",
            isPrivate ? "bg-mint text-primary-foreground" : "bg-success text-background",
          )}
        >
          G
        </span>
        <span className="font-mono text-token-xs text-foreground">gittensory[bot]</span>
        <span
          className={cn(
            "ml-auto rounded-token border-hairline px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider",
            isPrivate ? "text-mint" : "text-success",
          )}
        >
          {isPrivate ? "private" : "public-safe"}
        </span>
      </div>
      <div className="markdown-mini text-token-sm text-foreground/90">
        {body.split("\n").map((line, index) => (
          <p key={index} className={cn("min-h-[1em]", line.startsWith("- ") && "ml-2")}>
            {renderInline(line)}
          </p>
        ))}
      </div>
    </div>
  );
}

function renderInline(line: string) {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded-token bg-background/60 px-1 font-mono text-token-xs text-mint"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("_") && part.endsWith("_")) {
      return (
        <em key={index} className="text-muted-foreground">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <span key={index}>{part}</span>;
  });
}
