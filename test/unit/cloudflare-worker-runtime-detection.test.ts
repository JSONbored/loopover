import { describe, expect, it } from "vitest";
import { isCloudflareWorkerRuntime } from "../../src/api/routes";

describe("isCloudflareWorkerRuntime (gates the Worker-only PostHog error middleware in createApp)", () => {
  it("is false under plain Node -- the exact condition self-host's server.ts runs createApp()'s shared handler under", () => {
    // No mocking here on purpose: this asserts the REAL behavior of the real test runtime (Node), which is
    // also self-host's real runtime -- Node's own native `navigator.userAgent` is "Node.js/<version>", never
    // the Workers-specific literal. If this ever started returning true under Node, the Cloudflare-only PostHog
    // Worker capture would activate inside every self-hoster's own process the moment they set
    // WORKER_POSTHOG_API_KEY by accident (e.g. copy-pasting the wrong var name) -- a real (Workers-only),
    // test/workers/worker-runtime.test.ts proves the true side in an actual workerd isolate.
    expect(isCloudflareWorkerRuntime()).toBe(false);
    expect(navigator.userAgent).not.toBe("Cloudflare-Workers");
  });
});
