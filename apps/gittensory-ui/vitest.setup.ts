import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases.
afterEach(() => {
  cleanup();
});
