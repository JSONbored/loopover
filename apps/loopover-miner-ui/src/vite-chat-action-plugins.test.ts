import { describe, expect, it } from "vitest";

import { chatDiscoverAttemptActionsPlugin } from "../vite-chat-discover-attempt-actions";
import { chatGovernorActionsPlugin } from "../vite-chat-governor-actions";

// #7228: the app's documented persistent-service path (README + systemd/loopover-miner-ui.service.example) runs
// `npm run build && npm run preview`, and `vite preview` fires ONLY `configurePreviewServer`, never
// `configureServer`. These two chat-action plugins used to implement `configureServer` alone, so their governor
// and discover/attempt actions were silently unregistered in production — unlike every sibling vite-*-api.ts
// plugin, which registers for both hooks. Lock in that both plugins now wire both hooks.
describe("chat-action vite plugins register for dev AND preview servers (#7228)", () => {
  const cases = [
    ["chatGovernorActionsPlugin", chatGovernorActionsPlugin],
    ["chatDiscoverAttemptActionsPlugin", chatDiscoverAttemptActionsPlugin],
  ] as const;

  for (const [label, factory] of cases) {
    it(`${label} implements both configureServer and configurePreviewServer`, () => {
      const plugin = factory();
      expect(plugin.configureServer).toBeTypeOf("function");
      expect(plugin.configurePreviewServer).toBeTypeOf("function");
    });
  }
});
