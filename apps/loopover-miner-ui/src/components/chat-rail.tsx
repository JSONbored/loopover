// Persistent chat-rail shell (#6513). A pure structural shell mounted once in __root.tsx so it survives
// client-side route navigation: on wide viewports it docks as a ~380px panel beside the routed content; below
// the ui-kit `useIsMobile` breakpoint it collapses to the same `Sheet`-based slide-over `sidebar.tsx` uses for
// its own mobile mode (rather than a second, bespoke mobile-collapse mechanism). The rail's content slot is
// filled by the `ChatConversation` integration (#6518) — composer + message list + streaming renderer wired to
// the read-only `POST /api/chat` backend — rendered by both the docked panel and the mobile sheet.
import * as React from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@loopover/ui-kit/components/sheet";
import { useIsMobile } from "@loopover/ui-kit/hooks/use-mobile";

import { ChatConversation } from "@/components/chat/conversation";

const RAIL_WIDTH_PX = 380;
const RAIL_PANEL_ID = "chat-rail-panel";

/** The rail's inner content slot, filled by the read-only chat conversation integration (#6518). Rendered by
 *  both the mobile slide-over sheet and the desktop docked panel so a single wiring covers both presentations. */
function RailBody() {
  return <ChatConversation />;
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
          {/* forceMount: keep RailBody mounted when the sheet closes so chat state survives, matching the
              desktop `<aside hidden={!open}>` contract (#7792). SheetContent already forwards unknown props
              onto Radix Dialog.Content, which honors forceMount. */}
          <SheetContent id={RAIL_PANEL_ID} side="right" className="w-[380px] p-0" forceMount>
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
