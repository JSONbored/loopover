import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases (mirrors
// apps/loopover-miner-ui/vitest.setup.ts's own cleanup).
afterEach(() => {
  cleanup();
});
