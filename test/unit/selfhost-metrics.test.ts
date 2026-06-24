import { afterEach, describe, expect, it } from "vitest";
import { gauge, incr, renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

afterEach(() => resetMetrics());

describe("metrics registry (#982)", () => {
  it("counters accumulate and render", async () => {
    incr("c_total");
    incr("c_total", undefined, 2);
    expect((await renderMetrics())).toContain("c_total 3");
  });

  it("renders labels in Prometheus format", async () => {
    incr("h_total", { status: "ok" });
    expect((await renderMetrics())).toContain('h_total{status="ok"} 1');
  });

  it("sorts multiple labels deterministically", async () => {
    incr("m_total", { b: "2", a: "1" });
    expect((await renderMetrics())).toContain('m_total{a="1",b="2"} 1');
  });

  it("gauges sample at scrape time", async () => {
    let v = 5;
    gauge("g", () => v);
    expect((await renderMetrics())).toContain("g 5");
    v = 9;
    expect((await renderMetrics())).toContain("g 9");
  });

  it("a throwing gauge does not break the scrape", async () => {
    gauge("bad", () => {
      throw new Error("x");
    });
    incr("ok_total");
    expect((await renderMetrics())).toContain("ok_total 1");
  });
});
