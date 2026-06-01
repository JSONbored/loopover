import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/site/state-views";
import { cn } from "@/lib/utils";

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  group: string;
  items: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
  {
    group: "Navigation",
    items: [
      { keys: ["⌘", "K"], label: "Open command palette" },
      { keys: ["g", "h"], label: "Go home" },
      { keys: ["g", "d"], label: "Go to docs" },
      { keys: ["g", "a"], label: "Go to app" },
      { keys: ["g", "r"], label: "Go to API reference" },
    ],
  },
  {
    group: "API reference",
    items: [
      { keys: ["←"], label: "Previous endpoint" },
      { keys: ["→"], label: "Next endpoint" },
      { keys: ["["], label: "Previous tag section" },
      { keys: ["]"], label: "Next tag section" },
    ],
  },
  {
    group: "Reading",
    items: [
      { keys: ["j"], label: "Scroll down" },
      { keys: ["k"], label: "Scroll up" },
      { keys: ["t"], label: "Back to top" },
    ],
  },
  {
    group: "General",
    items: [
      { keys: ["?"], label: "Open this cheat sheet" },
      { keys: ["Esc"], label: "Close dialogs / menus" },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isTyping = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const inOpenDialog = () => {
      // Avoid hijacking keys when a Radix dialog/popover/menu is open and our own
      // sheet isn't already the one being toggled.
      const opened = document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
      return !!opened;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // "?" opens the sheet — always allow, even when other dialogs are open.
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setOpen(true);
        toast("Keyboard shortcuts opened", {
          description: "Shortcuts stay disabled while you type in inputs.",
        });
        return;
      }

      // For all other shortcuts, defer to any open dialog/menu.
      if (inOpenDialog()) return;

      // "t" back to top
      if (e.key === "t") {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (e.key === "j") {
        window.scrollBy({ top: window.innerHeight * 0.4, behavior: "smooth" });
        return;
      }
      if (e.key === "k") {
        window.scrollBy({ top: -window.innerHeight * 0.4, behavior: "smooth" });
        return;
      }

      // Two-key "g <x>" sequences
      if (e.key === "g") {
        setPending("g");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setPending(null), 900);
        return;
      }
      if (pending === "g") {
        const map: Record<string, string> = {
          h: "/",
          d: "/docs",
          a: "/app",
          r: "/api",
        };
        const target = map[e.key];
        setPending(null);
        if (target) {
          e.preventDefault();
          window.location.assign(target);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer) clearTimeout(timer);
    };
  }, [pending]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          toast("Keyboard shortcuts opened", {
            description: "Use ? from anywhere outside text inputs to reopen this sheet.",
          });
        }}
        aria-label="Open keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className="hidden h-7 w-7 items-center justify-center rounded-token border-hairline bg-transparent text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-strong md:inline-flex focus-ring motion-reduce:transition-none"
      >
        <Keyboard className="size-3" aria-hidden />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-token-base">
              <Keyboard className="size-4 text-mint" aria-hidden /> Keyboard shortcuts
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 grid gap-5">
            {GROUPS.length === 0 ? (
              <EmptyState
                title="No shortcuts available"
                description="Shortcut metadata did not load. Close this sheet and try opening it again."
              />
            ) : (
              GROUPS.map((g) => (
                <section key={g.group}>
                  <div className="mb-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    {g.group}
                  </div>
                  <ul className="space-y-1.5">
                    {g.items.map((s) => (
                      <li
                        key={s.label}
                        className="flex items-center justify-between gap-4 text-token-sm"
                      >
                        <span className="text-foreground/85">{s.label}</span>
                        <span className="flex items-center gap-1">
                          {s.keys.map((k, i) => (
                            <kbd
                              key={i}
                              className={cn(
                                "rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-token-2xs text-foreground",
                              )}
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
          <p className="mt-3 text-token-2xs text-muted-foreground">
            Tip: shortcuts are disabled while typing in inputs.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
