// Persistent chat-rail shell (#6513). A pure structural shell mounted once in __root.tsx so it survives
// client-side route navigation: on wide viewports it docks as a ~380px panel beside the routed content; below
// the ui-kit `useIsMobile` breakpoint it collapses to the same `Sheet`-based slide-over `sidebar.tsx` uses for
// its own mobile mode (rather than a second, bespoke mobile-collapse mechanism). This ships with static
// placeholder content only — no composer, message list, streaming, or backend call; those layer on later.
import * as React from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@loopover/ui-kit/components/sheet";
import { useIsMobile } from "@loopover/ui-kit/hooks/use-mobile";

const RAIL_WIDTH_PX = 380;
const RAIL_PANEL_ID = "chat-rail-panel";

/** The rail's inner content. Static placeholder for this shell issue — the real composer/message-list land later. */
function RailBody() {
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <p className="font-mono text-token-xs uppercase tracking-[0.2em] text-primary">Chat</p>
      <p className="text-token-sm text-muted-foreground">Ask about this miner&rsquo;s local state. Coming soon.</p>
    </div>
  );
}

export interface ChatRailProps {
  /** Whether the rail is expanded (docked panel / open sheet). Owned by the mounting shell so it survives nav. */
  open: boolean;
  /** Requests an open/closed change — from the toggle button or the sheet's own dismiss affordances. */
  onOpenChange: (open: boolean) => void;
}

export function ChatRail({ open, onOpenChange }: ChatRailProps) {
  const isMobile = useIsMobile();

  // Below the breakpoint: reuse the ui-kit Sheet slide-over (same mechanism sidebar.tsx uses on mobile), rather
  // than docking a 380px panel that would swamp a narrow viewport.
  if (isMobile) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={RAIL_PANEL_ID}
          onClick={() => onOpenChange(!open)}
        >
          Chat
        </Button>
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent id={RAIL_PANEL_ID} side="right" className="w-[380px] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Chat</SheetTitle>
              <SheetDescription>Ask about this miner&rsquo;s local state.</SheetDescription>
            </SheetHeader>
            <RailBody />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Wide viewport: dock a ~380px panel beside the routed content. Collapsing only hides it (never unmounts it),
  // so any future in-rail state is preserved across an expand/collapse cycle.
  return (
    <div className="flex shrink-0 flex-col items-end gap-2 p-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={RAIL_PANEL_ID}
        onClick={() => onOpenChange(!open)}
      >
        {open ? "Hide chat" : "Show chat"}
      </Button>
      <aside
        id={RAIL_PANEL_ID}
        aria-label="Chat"
        data-state={open ? "open" : "collapsed"}
        hidden={!open}
        style={open ? { width: RAIL_WIDTH_PX } : undefined}
        className="h-full border-l-hairline"
      >
        <RailBody />
      </aside>
    </div>
  );
}
