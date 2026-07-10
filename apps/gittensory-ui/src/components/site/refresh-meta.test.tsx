import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefreshMeta } from "@/components/site/refresh-meta";
import { relativeTimeFromNow } from "@/lib/utils";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("relativeTimeFromNow (#2219)", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  it("labels each bucket at and around its boundary", () => {
    // seconds bucket, including the exact lower edge and the last second before a minute
    expect(relativeTimeFromNow(now, now)).toBe("just now");
    expect(relativeTimeFromNow(now - 59_000, now)).toBe("just now");
    // minutes bucket: 60s flips to 1m; 59m59s still reads 59m
    expect(relativeTimeFromNow(now - MINUTE_MS, now)).toBe("1m ago");
    expect(relativeTimeFromNow(now - (HOUR_MS - 1000), now)).toBe("59m ago");
    // hours bucket: 60m flips to 1h; 23h59m still reads 23h
    expect(relativeTimeFromNow(now - HOUR_MS, now)).toBe("1h ago");
    expect(relativeTimeFromNow(now - (DAY_MS - MINUTE_MS), now)).toBe("23h ago");
    // days bucket: 24h flips to 1d and keeps counting
    expect(relativeTimeFromNow(now - DAY_MS, now)).toBe("1d ago");
    expect(relativeTimeFromNow(now - 3 * DAY_MS - 2 * HOUR_MS, now)).toBe("3d ago");
  });

  it("clamps a marginally-future timestamp to 'just now' instead of a negative age", () => {
    expect(relativeTimeFromNow(now + 5_000, now)).toBe("just now");
  });
});

describe("RefreshMeta (#2219)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 10, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing before the first successful load", () => {
    const { container } = render(<RefreshMeta loadedAt={null} onRefresh={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the relative label for the loaded timestamp", () => {
    render(<RefreshMeta loadedAt={Date.now() - 3 * MINUTE_MS} onRefresh={() => {}} />);
    expect(screen.getByText("last refresh 3m ago")).toBeTruthy();
  });

  it("advances the label on the interval tick without a reload", () => {
    render(<RefreshMeta loadedAt={Date.now()} onRefresh={() => {}} />);
    expect(screen.getByText("last refresh just now")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2 * MINUTE_MS);
    });
    expect(screen.getByText("last refresh 2m ago")).toBeTruthy();
  });

  it("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    render(<RefreshMeta loadedAt={Date.now()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables the button while a refresh is in flight", () => {
    const onRefresh = vi.fn();
    render(<RefreshMeta loadedAt={Date.now()} onRefresh={onRefresh} refreshing />);
    const button = screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("clears its interval on unmount", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(<RefreshMeta loadedAt={Date.now()} onRefresh={() => {}} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
