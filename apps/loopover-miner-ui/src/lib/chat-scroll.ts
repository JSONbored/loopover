/** Distance from the bottom (px) that still counts as "pinned" for stick-to-bottom auto-scroll (#7229). */
export const CHAT_NEAR_BOTTOM_PX = 80;

export function isChatViewportNearBottom(
  viewport: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  thresholdPx = CHAT_NEAR_BOTTOM_PX,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= thresholdPx;
}

export function scrollChatViewportToBottom(viewport: HTMLElement): void {
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}
