import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

const PKG = "@jsonbored/gittensory-mcp";

type NpmMeta = { "dist-tags": { latest: string } };

function useNpmLatest() {
  return useQuery({
    queryKey: ["npm-latest", PKG],
    queryFn: async (): Promise<string> => {
      const r = await fetch(`https://registry.npmjs.org/${PKG}`);
      if (!r.ok) throw new Error(`npm ${r.status}`);
      const j = (await r.json()) as NpmMeta;
      return j["dist-tags"]?.latest ?? "";
    },
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}

/**
 * Install snippet for the MCP, pinned to the current npm latest.
 * Falls back gracefully when the npm registry is unreachable.
 */
export function NpmInstall({ className }: { className?: string }) {
  const { data: version, isLoading, isError } = useNpmLatest();
  const [copied, setCopied] = useState(false);

  const command = version ? `npm i -g ${PKG}@${version}` : `npm i -g ${PKG}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Install command copied", {
        description: "Paste it into your terminal to install the MCP package.",
      });
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Copy failed", { description: "Select the command and copy it manually." });
    }
  };

  return (
    <div className={cn("group rounded-token border-hairline bg-card/40", className)}>
      <div className="flex items-center justify-between border-b-hairline px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          <Package className="size-3" aria-hidden />
          npm · {PKG}
        </span>
        <span className="font-mono text-token-2xs text-muted-foreground">
          {isLoading ? (
            <span className="inline-block h-2.5 w-12 animate-pulse rounded bg-muted align-middle" />
          ) : isError || !version ? (
            "latest"
          ) : (
            <span className="text-mint">v{version}</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span aria-hidden className="font-mono text-token-xs text-mint">
          $
        </span>
        <code className="flex-1 truncate font-mono text-token-xs text-foreground/90">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy install command"}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-token text-muted-foreground transition-colors duration-150 hover:text-foreground focus-ring"
        >
          {copied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
