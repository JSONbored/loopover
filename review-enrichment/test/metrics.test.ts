import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { counterValue, incr, observe, renderMetrics, resetMetrics } from "../dist/metrics.js";

beforeEach(() => {
  resetMetrics();
});

test("incr creates a counter on first use and accumulates on repeat calls", () => {
  assert.equal(counterValue("rees_enrich_requests_total", { status: "ok" }), 0);
  incr("rees_enrich_requests_total", { status: "ok" });
  incr("rees_enrich_requests_total", { status: "ok" });
  incr("rees_enrich_requests_total", { status: "unauthorized" });
  assert.equal(counterValue("rees_enrich_requests_total", { status: "ok" }), 2);
  assert.equal(counterValue("rees_enrich_requests_total", { status: "unauthorized" }), 1);
});

test("incr supports a custom increment amount", () => {
  incr("rees_analyzer_runs_total", { analyzer: "secret", status: "ok" }, 5);
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "secret", status: "ok" }), 5);
});

test("renderMetrics emits HELP/TYPE once per metric name, then one line per counter series", () => {
  incr("rees_enrich_requests_total", { status: "ok" });
  incr("rees_enrich_requests_total", { status: "http_error" });
  const text = renderMetrics();
  assert.equal(text.match(/# HELP rees_enrich_requests_total/g)?.length, 1);
  assert.equal(text.match(/# TYPE rees_enrich_requests_total counter/g)?.length, 1);
  assert.match(text, /rees_enrich_requests_total\{status="ok"\} 1/);
  assert.match(text, /rees_enrich_requests_total\{status="http_error"\} 1/);
});

test("observe accumulates a histogram's bucket counts, sum, and count, with a correct +Inf bucket", () => {
  observe("rees_analyzer_duration_seconds", 0.02, { analyzer: "redos" });
  observe("rees_analyzer_duration_seconds", 3, { analyzer: "redos" });
  const text = renderMetrics();
  assert.match(text, /rees_analyzer_duration_seconds_bucket\{analyzer="redos",le="0.025"\} 1/);
  assert.match(text, /rees_analyzer_duration_seconds_bucket\{analyzer="redos",le="5"\} 2/);
  assert.match(text, /rees_analyzer_duration_seconds_bucket\{analyzer="redos",le="\+Inf"\} 2/);
  assert.match(text, /rees_analyzer_duration_seconds_sum\{analyzer="redos"\} 3\.02/);
  assert.match(text, /rees_analyzer_duration_seconds_count\{analyzer="redos"\} 2/);
});

test("a metric name with no registered meta is still rendered, just without HELP/TYPE lines", () => {
  incr("rees_unregistered_metric_total");
  const text = renderMetrics();
  assert.doesNotMatch(text, /# HELP rees_unregistered_metric_total/);
  assert.match(text, /^rees_unregistered_metric_total 1$/m);
});

test("resetMetrics clears every series and restores the built-in metric metadata", () => {
  incr("rees_enrich_requests_total", { status: "ok" });
  observe("rees_analyzer_duration_seconds", 1, { analyzer: "secret" });
  resetMetrics();
  assert.equal(counterValue("rees_enrich_requests_total", { status: "ok" }), 0);
  incr("rees_enrich_requests_total", { status: "ok" });
  const text = renderMetrics();
  assert.equal(text.match(/# HELP rees_enrich_requests_total/g)?.length, 1);
  assert.doesNotMatch(text, /rees_analyzer_duration_seconds/);
});
