import { afterEach, describe, expect, it } from "vitest";
import { gauge, gaugeVector, incr, observe, registerMetricMeta, renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

afterEach(() => resetMetrics());

describe("metrics registry (#982)", () => {
  it("renders unregistered counters exactly as bare samples", async () => {
    incr("plain_total");

    expect(await renderMetrics()).toBe("plain_total 1\n");
  });

  it("prepends registered HELP and TYPE metadata once per metric name", async () => {
    registerMetricMeta("labeled_total", {
      help: "Total labeled samples from C:\\temp\nwith escaped help.",
      type: "counter",
    });
    incr("labeled_total", { result: "ok" });
    incr("labeled_total", { result: "error" });

    const out = await renderMetrics();
    expect(out.match(/^# HELP labeled_total /gm)).toHaveLength(1);
    expect(out).toContain("# HELP labeled_total Total labeled samples from C:\\\\temp\\nwith escaped help.");
    expect(out.match(/^# TYPE labeled_total counter$/gm)).toHaveLength(1);
    expect(out).toContain('labeled_total{result="ok"} 1');
    expect(out).toContain('labeled_total{result="error"} 1');
  });

  it("renders registered gauge metadata after a successful sample", async () => {
    registerMetricMeta("g", { help: "Current gauge value.", type: "gauge" });
    gauge("g", () => 7);

    expect(await renderMetrics()).toBe("# HELP g Current gauge value.\n# TYPE g gauge\ng 7\n");
  });

  it("renders registered histogram metadata before bucket series", async () => {
    registerMetricMeta("request_seconds", { help: "Request duration.", type: "histogram" });
    observe("request_seconds", 0.2, undefined, [0.1, 0.5]);

    const out = await renderMetrics();
    expect(out.startsWith("# HELP request_seconds Request duration.\n# TYPE request_seconds histogram\n")).toBe(true);
    expect(out).toContain('request_seconds_bucket{le="0.1"} 0');
    expect(out).toContain('request_seconds_bucket{le="0.5"} 1');
  });

  it("resetMetrics clears registered metadata", async () => {
    registerMetricMeta("cleared_total", { help: "Cleared counter.", type: "counter" });
    incr("cleared_total");
    resetMetrics();

    incr("cleared_total");
    expect(await renderMetrics()).toBe("cleared_total 1\n");
  });

  it("resetMetrics preserves seeded metadata for built-in metrics", async () => {
    resetMetrics();
    incr("gittensory_jobs_processed_total");

    expect(await renderMetrics()).toBe(
      "# HELP gittensory_jobs_processed_total Durable queue jobs processed successfully.\n# TYPE gittensory_jobs_processed_total counter\ngittensory_jobs_processed_total 1\n",
    );
  });

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

  it("redacts private repository labels from public review counters", async () => {
    incr("gittensory_reviews_published_total", { repo: "private-owner/secret-repo" });

    const out = await renderMetrics();
    expect(out).toContain("gittensory_reviews_published_total 1");
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain('repo="');
  });

  it("keeps non-sensitive gate labels after redacting the repository", async () => {
    incr("gittensory_gate_decisions_total", {
      repo: "private-owner/secret-repo",
      conclusion: "success",
    });

    const out = await renderMetrics();
    expect(out).toContain('gittensory_gate_decisions_total{conclusion="success"} 1');
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain('repo="');
  });

  it("keeps sensitive metric labels when no repository label is present", async () => {
    incr("gittensory_gate_decisions_total", { conclusion: "hold" });

    expect(await renderMetrics()).toContain('gittensory_gate_decisions_total{conclusion="hold"} 1');
  });

  it("preserves repository labels for unrelated metrics", async () => {
    incr("debug_total", { repo: "public-owner/public-repo" });
    expect(await renderMetrics()).toContain('debug_total{repo="public-owner/public-repo"} 1');
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

describe("gaugeVector (#selfhost-lane-observability)", () => {
  it("renders one series per labeled sample, sharing one HELP/TYPE block", async () => {
    registerMetricMeta("v", { help: "Vector gauge.", type: "gauge" });
    gaugeVector("v", () => [
      { labels: { repo: "owner/a" }, value: 3 },
      { labels: { repo: "owner/b" }, value: 5 },
    ]);

    const out = await renderMetrics();
    expect(out.match(/^# HELP v /gm)).toHaveLength(1);
    expect(out.match(/^# TYPE v gauge$/gm)).toHaveLength(1);
    expect(out).toContain('v{repo="owner/a"} 3');
    expect(out).toContain('v{repo="owner/b"} 5');
  });

  it("supports an async sampler", async () => {
    gaugeVector("async_v", async () => [{ labels: { key_scope: "public" }, value: 42 }]);
    expect(await renderMetrics()).toContain('async_v{key_scope="public"} 42');
  });

  it("emits HELP/TYPE with zero series for an empty sample array (no data, not absent)", async () => {
    registerMetricMeta("empty_v", { help: "Empty vector gauge.", type: "gauge" });
    gaugeVector("empty_v", () => []);

    const out = await renderMetrics();
    expect(out).toContain("# HELP empty_v Empty vector gauge.\n# TYPE empty_v gauge\n");
    expect(out).not.toMatch(/^empty_v\{/m);
  });

  it("a throwing sampler does not break the scrape", async () => {
    gaugeVector("bad_v", () => {
      throw new Error("x");
    });
    incr("ok_total");
    expect(await renderMetrics()).toContain("ok_total 1");
  });

  it("re-registering the same name replaces the sampler", async () => {
    gaugeVector("replaced_v", () => [{ labels: { x: "1" }, value: 1 }]);
    gaugeVector("replaced_v", () => [{ labels: { x: "2" }, value: 2 }]);

    const out = await renderMetrics();
    expect(out).not.toContain('replaced_v{x="1"}');
    expect(out).toContain('replaced_v{x="2"} 2');
  });

  it("resetMetrics clears gauge vectors", async () => {
    gaugeVector("cleared_v", () => [{ labels: { x: "1" }, value: 1 }]);
    resetMetrics();

    expect(await renderMetrics()).toBe("\n");
  });
});

describe("histograms (observe)", () => {
  it("renders cumulative buckets, +Inf, sum and count (default buckets)", async () => {
    observe("rq_seconds", 2); // 2 <= 2.5/5/10 but > 1
    const out = await renderMetrics();
    expect(out).toContain('rq_seconds_bucket{le="1"} 0'); // below the value → not counted
    expect(out).toContain('rq_seconds_bucket{le="2.5"} 1'); // first bucket >= value
    expect(out).toContain('rq_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain("rq_seconds_sum 2");
    expect(out).toContain("rq_seconds_count 1");
  });

  it("accumulates across observations into an existing series", async () => {
    observe("a_seconds", 0.01);
    observe("a_seconds", 0.01); // second observe hits the existing-series branch
    const out = await renderMetrics();
    expect(out).toContain('a_seconds_bucket{le="0.005"} 0'); // both observations are above 0.005
    expect(out).toContain('a_seconds_bucket{le="0.01"} 2'); // both <= 0.01
    expect(out).toContain("a_seconds_count 2");
    expect(out).toContain("a_seconds_sum 0.02");
  });

  it("honors a caller-provided bucket set", async () => {
    observe("c_seconds", 7, undefined, [1, 5, 10]);
    const out = await renderMetrics();
    expect(out).toContain('c_seconds_bucket{le="5"} 0');
    expect(out).toContain('c_seconds_bucket{le="10"} 1');
    expect(out).toContain('c_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain("c_seconds_sum 7");
  });

  it("renders labels on every histogram series", async () => {
    observe("l_seconds", 0.001, { route: "health" });
    const out = await renderMetrics();
    expect(out).toContain('l_seconds_bucket{le="0.005",route="health"} 1');
    expect(out).toContain('l_seconds_sum{route="health"} 0.001');
    expect(out).toContain('l_seconds_count{route="health"} 1');
  });

  it("resetMetrics clears histograms", async () => {
    observe("z_seconds", 1);
    resetMetrics();
    expect(await renderMetrics()).toBe("\n");
  });
});
