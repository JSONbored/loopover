import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupAcknowledgedGaugeValue } from "../../src/selfhost/health";
import {
  DEFAULT_METRIC_META,
  counterValue,
  gauge,
  gaugeVector,
  hitRatio,
  httpRouteGroup,
  incr,
  observe,
  registerMetricMeta,
  renderMetrics,
  resetMetrics,
  setSelfHostedMetricsMode,
  setSelfHostedRawRepoLabels,
} from "../../src/selfhost/metrics";

afterEach(() => {
  resetMetrics();
  // setSelfHostedMetricsMode/setSelfHostedRawRepoLabels are separate module-level flags from the
  // counters/gauges resetMetrics() clears -- reset them explicitly so a test that turns either on can never
  // leak into an unrelated later test.
  setSelfHostedMetricsMode(false);
  setSelfHostedRawRepoLabels(false);
});

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
    incr("loopover_jobs_processed_total");

    expect(await renderMetrics()).toBe(
      "# HELP loopover_jobs_processed_total Durable queue jobs processed successfully.\n# TYPE loopover_jobs_processed_total counter\nloopover_jobs_processed_total 1\n",
    );
  });

  it("renders loopover_backup_acknowledged with seeded metadata (#2089)", async () => {
    gauge("loopover_backup_acknowledged", () =>
      backupAcknowledgedGaugeValue({ usingSqlite: true, backupAcknowledged: false }),
    );

    expect(await renderMetrics()).toBe(
      "# HELP loopover_backup_acknowledged 1 when SQLite backup is acknowledged or Postgres is in use; 0 when the boot backup advisory would fire.\n# TYPE loopover_backup_acknowledged gauge\nloopover_backup_acknowledged 0\n",
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
    incr("loopover_reviews_published_total", { repo: "private-owner/secret-repo" });

    const out = await renderMetrics();
    expect(out).toContain("loopover_reviews_published_total 1");
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain('repo="');
  });

  it("keeps non-sensitive gate labels after redacting the repository", async () => {
    incr("loopover_gate_decisions_total", {
      repo: "private-owner/secret-repo",
      conclusion: "success",
    });

    const out = await renderMetrics();
    expect(out).toContain('loopover_gate_decisions_total{conclusion="success"} 1');
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain('repo="');
  });

  it("keeps sensitive metric labels when no repository label is present", async () => {
    incr("loopover_gate_decisions_total", { conclusion: "hold" });

    expect(await renderMetrics()).toContain('loopover_gate_decisions_total{conclusion="hold"} 1');
  });

  it("redacts the repository label from the ops anomaly counter but keeps the kind label (#ops-anomaly-metric)", async () => {
    incr("loopover_ops_anomaly_total", { repo: "private-owner/secret-repo", kind: "review_burst" });

    const out = await renderMetrics();
    expect(out).toContain('loopover_ops_anomaly_total{kind="review_burst"} 1');
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain('repo="');
  });

  it("preserves repository labels for unrelated metrics", async () => {
    incr("debug_total", { repo: "public-owner/public-repo" });
    expect(await renderMetrics()).toContain('debug_total{repo="public-owner/public-repo"} 1');
  });

  // #terminal-outcome-audit / #9142: a self-hosted instance's /metrics is the operator's own private scrape
  // target, not a publicly reachable one, but /metrics is commonly exposed by a reverse proxy before any
  // application auth -- setSelfHostedMetricsMode(true) (called unconditionally at self-host boot) must NOT
  // serve the raw repo name by default. It now pseudonymizes (the SAME redacted-N scheme
  // ALWAYS_REDACT_REPO_LABEL_METRICS already uses) so an operator's own dashboards still get a stable
  // per-repo series to group by, without the real name leaving the instance by default.
  it("setSelfHostedMetricsMode(true) pseudonymizes (not strips, not raw) the repo label on the private counters by default", async () => {
    setSelfHostedMetricsMode(true);
    incr("loopover_gate_decisions_total", { repo: "owner/repo", conclusion: "success" });
    incr("loopover_reviews_published_total", { repo: "owner/repo" });
    incr("loopover_ops_anomaly_total", { repo: "owner/repo", kind: "review_burst" });

    const out = await renderMetrics();
    expect(out).toContain('loopover_gate_decisions_total{conclusion="success",repo="redacted-1"} 1');
    expect(out).toContain('loopover_reviews_published_total{repo="redacted-1"} 1');
    expect(out).toContain('loopover_ops_anomaly_total{kind="review_burst",repo="redacted-1"} 1');
    expect(out).not.toContain("owner/repo");
  });

  it("setSelfHostedRawRepoLabels(true) restores raw repo labels in self-hosted metrics mode (explicit operator opt-in)", async () => {
    setSelfHostedMetricsMode(true);
    setSelfHostedRawRepoLabels(true);
    incr("loopover_gate_decisions_total", { repo: "owner/repo", conclusion: "success" });
    incr("loopover_reviews_published_total", { repo: "owner/repo" });
    incr("loopover_ops_anomaly_total", { repo: "owner/repo", kind: "review_burst" });

    const out = await renderMetrics();
    expect(out).toContain('loopover_gate_decisions_total{conclusion="success",repo="owner/repo"} 1');
    expect(out).toContain('loopover_reviews_published_total{repo="owner/repo"} 1');
    expect(out).toContain('loopover_ops_anomaly_total{kind="review_burst",repo="owner/repo"} 1');
    expect(out).toContain('repo="owner/repo"');
  });

  it("setSelfHostedRawRepoLabels(true) has no effect while self-hosted metrics mode is off (still strips)", async () => {
    setSelfHostedRawRepoLabels(true);
    incr("loopover_gate_decisions_total", { repo: "owner/repo", conclusion: "success" });

    const out = await renderMetrics();
    expect(out).toContain('loopover_gate_decisions_total{conclusion="success"} 1');
    expect(out).not.toContain("owner/repo");
    expect(out).not.toContain('repo="');
  });

  it("setSelfHostedMetricsMode(false) (the default) still redacts — byte-identical to the cloud worker", async () => {
    setSelfHostedMetricsMode(false);
    incr("loopover_agent_disposition_total", { repo: "owner/repo", action_class: "hold", blocker_class: "none", autonomy_level: "auto" });

    const out = await renderMetrics();
    expect(out).not.toContain("owner/repo");
    expect(out).toContain(
      'loopover_agent_disposition_total{action_class="hold",autonomy_level="auto",blocker_class="none",repo="redacted-1"} 1',
    );
  });

  it("keeps agent disposition repository labels redacted in self-hosted metrics mode", async () => {
    setSelfHostedMetricsMode(true);
    incr("loopover_agent_disposition_total", {
      repo: "private-owner/secret-repo",
      action_class: "hold",
      blocker_class: "manifest_blocked",
      autonomy_level: "auto",
    });

    const out = await renderMetrics();
    expect(out).toContain(
      'loopover_agent_disposition_total{action_class="hold",autonomy_level="auto",blocker_class="manifest_blocked",repo="redacted-1"} 1',
    );
    expect(out).not.toContain("private-owner/secret-repo");
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

  // #9139: a throwing sampler previously vanished entirely -- no series, no counter, no trace it ever
  // existed this scrape. Every queue-backlog alert reads exactly this shape of gauge (a live DB read), so a
  // DB incident silently deactivated the alerts meant to catch it. Now the failure is itself counted and the
  // gauge still emits a -1 sentinel (the same "impossible for a healthy gauge" convention as
  // loopover_clock_skew_sample_age_seconds), so its absence is visible instead of silent.
  describe("failing gauge sampler visibility (#9139)", () => {
    it("counts the failure by metric name and emits a -1 sentinel series instead of vanishing", async () => {
      registerMetricMeta("bad_gauge", { help: "A gauge that throws.", type: "gauge" });
      gauge("bad_gauge", () => {
        throw new Error("db down");
      });

      const out = await renderMetrics();
      expect(out).toContain("bad_gauge -1");
      expect(out).toContain('loopover_metrics_sampler_errors_total{metric="bad_gauge"} 1');
    });

    it("accumulates across repeated scrapes (a sustained failure, not a one-shot)", async () => {
      gauge("still_bad", () => {
        throw new Error("still down");
      });

      await renderMetrics();
      await renderMetrics();
      const out = await renderMetrics();
      expect(out).toContain('loopover_metrics_sampler_errors_total{metric="still_bad"} 3');
    });

    it("does not touch the sampler-errors counter for a gauge that succeeds (the other arm)", async () => {
      gauge("healthy_gauge", () => 42);

      const out = await renderMetrics();
      expect(out).toContain("healthy_gauge 42");
      expect(out).not.toContain("loopover_metrics_sampler_errors_total");
    });

    it("counts an async gauge sampler's rejection the same as a sync throw", async () => {
      gauge("bad_async_gauge", async () => {
        throw new Error("async db down");
      });

      const out = await renderMetrics();
      expect(out).toContain("bad_async_gauge -1");
      expect(out).toContain('loopover_metrics_sampler_errors_total{metric="bad_async_gauge"} 1');
    });
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

  it("redacts repository labels from the public backlog-by-repo gauge vector", async () => {
    gaugeVector("loopover_queue_backlog_by_repo", () => [
      { labels: { rank: "1", repo: "private-owner/secret-repo" }, value: 3 },
      { labels: { rank: "2", repo: "other-org/confidential" }, value: 1 },
    ]);

    const out = await renderMetrics();
    expect(out).toContain('loopover_queue_backlog_by_repo{rank="1",repo="redacted-1"} 3');
    expect(out).toContain('loopover_queue_backlog_by_repo{rank="2",repo="redacted-2"} 1');
    resetMetrics();
    gaugeVector("loopover_queue_backlog_by_repo", () => [
      { labels: { repo: "private-owner/secret-repo" }, value: 4 },
    ]);
    expect(await renderMetrics()).toContain('loopover_queue_backlog_by_repo{repo="redacted-1"} 4');
    expect(out).not.toContain("private-owner/secret-repo");
    expect(out).not.toContain("other-org/confidential");
  });

  it("keeps backlog-by-repo redacted even in self-hosted metrics mode", async () => {
    setSelfHostedMetricsMode(true);
    gaugeVector("loopover_queue_backlog_by_repo", () => [
      { labels: { rank: "1", repo: "owner/repo" }, value: 2 },
    ]);

    const out = await renderMetrics();
    expect(out).toContain('loopover_queue_backlog_by_repo{rank="1",repo="redacted-1"} 2');
    expect(out).not.toContain("owner/repo");
  });

  it("reuses the same redacted label for a repo across repeated scrapes, without resetting", async () => {
    gaugeVector("loopover_queue_backlog_by_repo", () => [
      { labels: { rank: "1", repo: "owner/repo" }, value: 2 },
    ]);

    const first = await renderMetrics();
    const second = await renderMetrics();
    expect(first).toContain('loopover_queue_backlog_by_repo{rank="1",repo="redacted-1"} 2');
    expect(second).toContain('loopover_queue_backlog_by_repo{rank="1",repo="redacted-1"} 2');
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

  // #9139: same failure-visibility fix as the plain gauge() case, adapted for a vector's unknown-at-failure
  // label set -- there's no single value to sentinel, so only the failure counter is the actionable signal.
  it("counts a failing gaugeVector sampler by metric name, even though it has no single value to sentinel (#9139)", async () => {
    registerMetricMeta("bad_vector_gauge", { help: "A vector gauge that throws.", type: "gauge" });
    gaugeVector("bad_vector_gauge", () => {
      throw new Error("db down");
    });

    const out = await renderMetrics();
    expect(out).toContain('loopover_metrics_sampler_errors_total{metric="bad_vector_gauge"} 1');
    expect(out).not.toMatch(/^bad_vector_gauge\{/m);
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

  // #9142: observe() used to build its series key and store its labels WITHOUT routing through
  // publicLabelsForMetric -- the one metric-recording path that bypassed redaction entirely, including the
  // ALWAYS_REDACT_REPO_LABEL_METRICS set incr()/gaugeVector() always honor. Reuses an ALWAYS_REDACT name here
  // (rather than a PRIVATE_REPO_LABEL_METRICS one) so the assertion holds regardless of selfHostedMetricsMode.
  it("redacts a repo label on a histogram observation the same as incr()/gaugeVector() (#9142)", async () => {
    observe("loopover_merge_train_deferred_total", 1, { repo: "owner/repo" });
    const out = await renderMetrics();
    expect(out).toContain('loopover_merge_train_deferred_total_bucket{le="+Inf",repo="redacted-1"}');
    expect(out).not.toContain("owner/repo");
  });
});

describe("hitRatio (#2090)", () => {
  afterEach(() => resetMetrics());

  it("returns hits / (hits + misses) for normal samples", () => {
    expect(hitRatio(3, 1)).toBe(0.75);
    expect(hitRatio(5, 0)).toBe(1);
    expect(hitRatio(0, 5)).toBe(0);
  });

  it("returns 0 when there are no samples yet (divide-by-zero guard)", () => {
    expect(hitRatio(0, 0)).toBe(0);
  });

  it("counterValue reads labeled counter totals and defaults missing series to 0", () => {
    incr("loopover_redis_gh_response_cache_total", { result: "hit" }, 4);
    incr("loopover_redis_gh_response_cache_total", { result: "miss" }, 1);
    expect(counterValue("loopover_redis_gh_response_cache_total", { result: "hit" })).toBe(4);
    expect(counterValue("loopover_redis_gh_response_cache_total", { result: "miss" })).toBe(1);
    expect(counterValue("loopover_redis_gh_response_cache_total", { result: "set" })).toBe(0);
  });
});

describe("DEFAULT_METRIC_META completeness (drift guard, 2026-07 fix)", () => {
  // Recursively walk src/ collecting every incr(/gauge(/gaugeVector(/observe( call site that uses a literal
  // string metric name (dynamically-built names can't be statically checked this way, and there are none
  // today). Every one of those names must carry HELP/TYPE metadata, or renderMetrics() silently emits it as a
  // bare, undocumented sample forever -- exactly the class of gap #1943's audit found ~15 of.
  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTsFiles(full));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  it("every literal metric name emitted anywhere in src/ has a registered DEFAULT_METRIC_META entry", () => {
    const registered = new Set(DEFAULT_METRIC_META.map(([name]) => name));
    const used = new Set<string>();
    const pattern = /\b(?:incr|gauge|gaugeVector|observe)\(\s*"([a-z0-9_]+)"/g;
    for (const file of collectTsFiles(join(process.cwd(), "src"))) {
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(pattern)) used.add(match[1]!);
    }
    expect(used.size).toBeGreaterThan(50); // sanity: the scan found the real call sites, not an empty tree
    const missing = [...used].filter((name) => !registered.has(name)).sort();
    expect(missing).toEqual([]);
  });
});

// #9487: LoopoverRequestLatencySLOBreach fired at p95 = 9.75s against a 1s SLO and was UNACTIONABLE — the
// histogram carried no route label, so `sum by (le, route) (...)` returned one unlabelled series and the
// alert could not be attributed to anything. The reason it had no label is exactly why this one is an
// allowlist: an unbounded label value is the failure that takes Prometheus down, not merely misinforms it.
describe("httpRouteGroup (#9487)", () => {
  it("groups a /v1 route by its first segment", () => {
    expect(httpRouteGroup("/v1/github/webhook")).toBe("github");
    expect(httpRouteGroup("/v1/mcp")).toBe("mcp");
    expect(httpRouteGroup("/v1/public/stats")).toBe("public");
    expect(httpRouteGroup("/v1/repos/owner/name/agent/pending-actions")).toBe("repos");
  });

  it("groups the public asset/shot surface", () => {
    expect(httpRouteGroup("/loopover/shot?key=abc")).toBe("loopover");
  });

  it("REGRESSION: an UNKNOWN path is always `other` — cardinality is bounded by construction, not by sanitizing", () => {
    // The decisive property. A caller-controlled path (or an id embedded in one) must add zero new series,
    // so probing random paths cannot grow the metric at all.
    for (const path of [
      "/",
      "/nope",
      "/v1/",
      "/v1/not-a-real-surface/x",
      "/v1/github-but-not-really",
      "/v2/github/webhook",
      "/v1/../../etc/passwd",
      `/v1/${"x".repeat(5000)}`,
      "/loopoverx/shot",
    ]) {
      expect(httpRouteGroup(path), path).toBe("other");
    }
  });

  it("INVARIANT: the group set is finite, so the label can only ever take a known value", () => {
    // Fuzz over random paths: every result must be a value the allowlist could produce. This is the property
    // that makes the label safe to ship on a per-request histogram at all.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(httpRouteGroup(`/v1/${Math.random().toString(36).slice(2)}/${i}`));
      seen.add(httpRouteGroup(`/${Math.random().toString(36).slice(2)}`));
    }
    expect([...seen]).toEqual(["other"]);
  });

  it("INVARIANT: a per-PR path never leaks an id into the label", () => {
    expect(httpRouteGroup("/v1/repos/acme/widgets/pulls/12345/review")).toBe("repos");
    expect(httpRouteGroup("/v1/orb/instances/inst-abc-123/status")).toBe("orb");
  });
});
