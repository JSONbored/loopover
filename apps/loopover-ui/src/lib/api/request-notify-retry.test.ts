import { beforeEach, describe, expect, it, vi } from "vitest";

// #8676: notifyApiFailure shows a sonner toast whose "Retry" action drives runRetryWithProgress' in-flight
// re-entrancy guard. Mock sonner to capture each toast.error's action.onClick, and stub ./status so
// pingHealth/getApiStatus don't touch the network.
const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("./status", () => ({
  beginRequest: vi.fn(),
  endRequest: vi.fn(),
  reportApiFailure: vi.fn(),
  reportApiOk: vi.fn(),
  describeApiStatus: () => "",
  getApiStatus: () => ({ status: "ok" }),
  pingHealth: vi.fn(),
}));

import { notifyApiFailure } from "./request";

function lastRetryAction(): () => void {
  const calls = (toast.error as ReturnType<typeof vi.fn>).mock.calls;
  const opts = calls.at(-1)?.[1] as { action?: { onClick: () => void } } | undefined;
  return opts?.action?.onClick as () => void;
}

describe("notifyApiFailure re-entrancy guard (#8676)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves an in-flight retrying flag so a mid-retry notifyApiFailure can't double-fire the retry", async () => {
    // A retry that never settles keeps `retrying` true for the whole test (the .finally that clears it never runs).
    const retry = vi.fn(() => new Promise<void>(() => {}));
    notifyApiFailure({ label: "widget", kind: "http", status: 500, retry });
    lastRetryAction()(); // click Retry -> runRetryWithProgress sets retrying:true, calls retry() (next microtask)
    await Promise.resolve(); // flush the `Promise.resolve().then(() => retry())` hop
    expect(retry).toHaveBeenCalledTimes(1);

    // A second failure notification for the SAME label lands while the first retry is still in flight. Before
    // #8676 this full-object-replaced the entry, resetting retrying:false and defeating the guard.
    notifyApiFailure({ label: "widget", kind: "http", status: 500, retry });
    lastRetryAction()(); // click Retry again -> must be blocked by the still-true retrying guard
    await Promise.resolve();
    expect(retry).toHaveBeenCalledTimes(1); // still once, not a concurrent second run
  });

  it("still updates repeatCount on repeat failures when no retry is in flight (regression)", () => {
    const retry = vi.fn();
    notifyApiFailure({ label: "poll", kind: "network", retry });
    notifyApiFailure({ label: "poll", kind: "network", retry }); // same kind within 5s -> repeatCount 2
    const opts = (toast.error as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
      description?: unknown;
    };
    expect(String(opts?.description)).toContain("2× in a row");
  });
});
