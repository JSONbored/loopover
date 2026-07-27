import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { patchJsdomLocalStorageForNode26 } from "../../test/helpers/vitest-jsdom-node26-localstorage.js";

// Unmount React trees between tests so jsdom state never leaks across cases (mirrors
// apps/loopover-miner-ui/vitest.setup.ts's own cleanup).
afterEach(() => {
  cleanup();
});

// See vitest-jsdom-node26-localstorage.ts's own header. No component here calls localStorage today --
// this package is a shared UI kit other workspaces build on, so the guard is preventive.
patchJsdomLocalStorageForNode26();
