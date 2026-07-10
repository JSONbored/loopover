import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueueHealthCard } from "@/components/site/app-panels/queue-health-card";
import {
  formatQueueHealthGeneratedAt,
  queueHealthStatus,
  type QueueHealthCardModel,
} from "@/components/site/app-panels/queue-health-card-model";

function card(overrides: Partial<QueueHealthCardModel> = {}): QueueHealthCardModel {
  return {
    generatedAt: "2026-07-10T12:00:00.000Z",
    stale: false,
    pending: 4,
    inFlight: 2,
    stuck: 0,
    dlq: 0,
    queueDepthTrend: [2, 3, 4, 5, 4],
    summary: "Queue health looks clear across shaped repos.",
    ...overrides,
  };
}

describe("queueHealthStatus", () => {
  it("flags stale snapshots first", () => {
    expect(queueHealthStatus(card({ stale: true, stuck: 3, dlq: 2 }))).toBe("stale");
  });

  it("flags DLQ pressure when duplicate-risk clusters are present", () => {
    expect(queueHealthStatus(card({ dlq: 1 }))).toBe("blocked");
  });

  it("warns when stale PRs are present but DLQ is clear", () => {
    expect(queueHealthStatus(card({ stuck: 2 }))).toBe("warn");
  });

  it("reports healthy when counts are clear and the snapshot is fresh", () => {
    expect(queueHealthStatus(card())).toBe("ready");
  });
});

describe("QueueHealthCard", () => {
  it("renders healthy queue stats and the queue-depth trend", () => {
    render(<QueueHealthCard card={card()} />);
    expect(screen.getByText("Queue health")).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("Queue depth trend")).toBeTruthy();
    expect(screen.getByLabelText("Trend chart")).toBeTruthy();
  });

  it("renders a warn state when stuck PRs are present", () => {
    render(
      <QueueHealthCard card={card({ stuck: 3, summary: "3 stale PR(s) across shaped repos." })} />,
    );
    expect(screen.getByText("stale PRs present")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("renders a blocked state when DLQ duplicate-risk clusters are present", () => {
    render(
      <QueueHealthCard card={card({ dlq: 2, summary: "2 high-risk duplicate cluster(s)." })} />,
    );
    expect(screen.getByText("duplicate risk")).toBeTruthy();
    expect(screen.getByText("2 high-risk duplicate cluster(s).")).toBeTruthy();
  });

  it("renders a stale snapshot pill and generatedAt timestamp", () => {
    render(<QueueHealthCard card={card({ stale: true })} />);
    expect(screen.getByText("stale snapshot")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(formatQueueHealthGeneratedAt("2026-07-10T12:00:00.000Z"))),
    ).toBeTruthy();
  });

  it("shows a placeholder when queue-depth history has not accumulated yet", () => {
    render(<QueueHealthCard card={card({ queueDepthTrend: [] })} />);
    expect(screen.getByText(/Queue-depth history will appear/)).toBeTruthy();
  });
});

describe("formatQueueHealthGeneratedAt", () => {
  it("returns the raw value when the timestamp cannot be parsed", () => {
    expect(formatQueueHealthGeneratedAt("not-a-date")).toBe("not-a-date");
  });
});
