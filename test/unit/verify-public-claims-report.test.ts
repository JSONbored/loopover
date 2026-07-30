import { describe, expect, it, vi } from "vitest";

import {
  buildVerificationReport,
  claimLinesFor,
  escapeCell,
  OUTPUT_DELIMITER,
  parseArgs,
  parseRun,
  renderGithubOutput,
  runCli,
  summarize,
  TRACKING_ISSUE_TITLE,
  type VerifyRun,
} from "../../scripts/verify-public-claims-report";

// #9724: the nightly job's judgement, tested away from the network.
//
// The whole value of this monitor is that it says something true on the night it fires, and the ways a monitor
// goes wrong are asymmetric: a false red wastes an hour, a false GREEN means the published verification path is
// broken and nobody is told. So the cases that must NOT be green are pinned at least as hard as the happy path.

const claim = (status: string, over: Record<string, unknown> = {}) => ({
  id: "corpus-commitments",
  claim: "Every corpusChecksum matches a downloadable corpus",
  status,
  detail: "3 case(s) rehashed exactly",
  ...over,
});

const run = (over: Partial<VerifyRun> = {}): VerifyRun => ({
  label: "public API",
  baseUrl: "https://api.loopover.ai",
  exitCode: 0,
  report: { results: [claim("pass")] },
  ...over,
});

describe("claimLinesFor", () => {
  it("labels each claim with its surface", () => {
    expect(claimLinesFor(run())).toEqual([
      { surface: "public API", status: "pass", claim: "Every corpusChecksum matches a downloadable corpus", detail: "3 case(s) rehashed exactly" },
    ]);
  });

  it("falls back through the identifying fields rather than indexing blindly into a malformed claim", () => {
    const lines = claimLinesFor(run({ report: { results: [{ id: "stats-parity" }, {}] } }));
    expect(lines[0]).toMatchObject({ status: "unknown", claim: "stats-parity", detail: "(no detail published)" });
    expect(lines[1]).toMatchObject({ claim: "(unnamed claim)" });
  });

  it("yields nothing for a report with no results array (the caller turns that into its own failure)", () => {
    expect(claimLinesFor(run({ report: null }))).toEqual([]);
    expect(claimLinesFor(run({ report: {} }))).toEqual([]);
    expect(claimLinesFor(run({ report: { results: "nope" } }))).toEqual([]);
  });

  it("compares status case-insensitively, so an upper-cased report is still understood", () => {
    expect(claimLinesFor(run({ report: { results: [claim("FAIL")] } }))[0]?.status).toBe("fail");
  });
});

describe("buildVerificationReport", () => {
  it("is green when every claim passes", () => {
    const report = buildVerificationReport([run(), run({ label: "Orb ledger", baseUrl: "https://shots.loopover.ai" })]);
    expect(report.ok).toBe(true);
    expect(report.body).toBe("");
    expect(summarize(report)).toBe("2 passed, 0 failed, 0 skipped");
  });

  it("INVARIANT: skips alone are green -- a disabled surface is not a broken one", () => {
    // The public API's ledger is empty BY DESIGN (#9940), so its ledger claims skip every single night. If a
    // skip opened an issue, this job would file an outage on day one and be muted by week one.
    const report = buildVerificationReport([run({ report: { results: [claim("skip"), claim("pass")] } })]);
    expect(report.ok).toBe(true);
    expect(report.skips).toHaveLength(1);
  });

  it("reports a failing claim, naming the surface and carrying the detail through", () => {
    const report = buildVerificationReport([
      run({ report: { results: [claim("fail", { detail: "committed abc…, corpus hashes to def…" })] } }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.title).toBe(TRACKING_ISSUE_TITLE);
    expect(report.body).toContain("public API");
    expect(report.body).toContain("committed abc…, corpus hashes to def…");
    expect(report.body).toContain("npx -p @loopover/mcp loopover-verify --base-url https://api.loopover.ai");
  });

  it("REGRESSION: a run that produced NO readable report is a failure, not a silent pass", () => {
    // The subtle false-green. Nothing failed because nothing RAN -- npx could not resolve the package, or the
    // CLI crashed before emitting JSON. Counting zero failing claims as health is how a monitor reports green
    // for a verification path that no longer works at all.
    const report = buildVerificationReport([run({ report: null, exitCode: 1 })]);
    expect(report.ok).toBe(false);
    expect(report.body).toContain("the verifier produced no readable report");
  });

  it("REGRESSION: a non-zero exit with no failing claim is a failure", () => {
    // Two contradictory signals, and the comfortable one is wrong. An empty claim list next to a non-zero exit
    // means the tool hit something its own claims do not describe.
    const report = buildVerificationReport([run({ exitCode: 2, report: { results: [claim("pass")] } })]);
    expect(report.ok).toBe(false);
    expect(report.body).toContain("non-zero exit with no failing claim");
  });

  it("does not double-report a run that both failed a claim and exited non-zero", () => {
    // The ordinary failing case: exit 1 BECAUSE a claim failed. It must be described once, as the claim.
    const report = buildVerificationReport([run({ exitCode: 1, report: { results: [claim("fail")] } })]);
    expect(report.ok).toBe(false);
    expect(report.body).not.toContain("non-zero exit with no failing claim");
    expect(report.body).toContain("Failing claims");
  });

  it("lists skips alongside failures, since a new skip is often the cause", () => {
    const report = buildVerificationReport([run({ report: { results: [claim("fail"), claim("skip", { claim: "anchor checkpoint" })] } })]);
    expect(report.body).toContain("Skipped (not counted as failures)");
    expect(report.body).toContain("anchor checkpoint");
  });

  it("names every surface in the reproduce block, not just the failing one", () => {
    // A reader debugging one surface almost always needs to know what the other one said.
    const report = buildVerificationReport([
      run({ report: { results: [claim("fail")] } }),
      run({ label: "Orb ledger", baseUrl: "https://shots.loopover.ai" }),
    ]);
    expect(report.body).toContain("--base-url https://api.loopover.ai");
    expect(report.body).toContain("--base-url https://shots.loopover.ai");
  });

  it("handles no runs at all as green rather than throwing", () => {
    expect(buildVerificationReport([]).ok).toBe(true);
  });

  // Case 4, and the reason this job is worth having. Found by pointing the real verifier at a deliberately
  // wrong base URL, which is the self-verification #9724's acceptance asks for.
  describe("a run that verified NOTHING (#9724 acceptance)", () => {
    // Captured verbatim from `loopover-verify --base-url https://api.loopover.ai/definitely-not-the-api --json`.
    // Four legitimate skips and exit 0 -- judged claim-by-claim this looks entirely healthy, which is exactly
    // why the monitor has to apply a rule the CLI cannot.
    const wrongBaseUrl = (): VerifyRun => ({
      label: "public API",
      baseUrl: "https://api.loopover.ai/definitely-not-the-api",
      exitCode: 0,
      report: {
        results: [
          { id: "record-digests", claim: "Every eval-score record's recordDigest recomputes from its own contents", status: "skip", detail: "/v1/public/eval-scores unavailable (HTTP 404)" },
          { id: "corpus-commitments", claim: "Every corpusChecksum matches a downloadable corpus", status: "skip", detail: "/v1/public/eval-scores unavailable (HTTP 404)" },
          { id: "anchor-checkpoint", claim: "The current signed ledger checkpoint verifies offline against a published key", status: "skip", detail: "no signed checkpoint published, and the ledger size is unknown" },
          { id: "stats-parity", claim: "Published headline stats agree with the ledger-derived parity rollups", status: "skip", detail: "/v1/public/stats unavailable (HTTP 404)" },
        ],
      },
    });

    it("REGRESSION: turns the job RED, though every claim skipped and the CLI exited 0", () => {
      const report = buildVerificationReport([wrongBaseUrl()]);
      expect(report.ok).toBe(false);
      expect(report.body).toContain("nothing was verified");
      expect(report.body).toContain("https://api.loopover.ai/definitely-not-the-api");
    });

    it("goes green again the moment the base URL is corrected", () => {
      // The other half of the acceptance criterion: restoring the config recovers, so the tracking issue gets
      // closed rather than needing a human to notice it is stale.
      const corrected = { ...wrongBaseUrl(), baseUrl: "https://api.loopover.ai", report: { results: [claim("pass"), claim("skip")] } };
      expect(buildVerificationReport([corrected]).ok).toBe(true);
    });

    it("holds each surface to the floor independently, so one dead host cannot hide behind a healthy one", () => {
      const healthy = run({ report: { results: [claim("pass")] } });
      expect(buildVerificationReport([healthy, wrongBaseUrl()]).ok).toBe(false);
    });

    it("INVARIANT: production's real, lopsided pass/skip mixes both clear the floor", () => {
      // Measured against production, and the reason the floor is ONE rather than a proportion. api.loopover.ai
      // skips anchor-checkpoint (its ledger is empty by design, #9940) while shots.loopover.ai skips the three
      // stats claims (it publishes no stats). "Most claims pass" would fail the Orb every healthy night.
      const api = run({
        label: "public API",
        report: { results: [claim("pass", { id: "record-digests" }), claim("pass", { id: "corpus-commitments" }), claim("skip", { id: "anchor-checkpoint" }), claim("pass", { id: "stats-parity" })] },
      });
      const orb = run({
        label: "Orb ledger",
        baseUrl: "https://shots.loopover.ai",
        report: { results: [claim("skip", { id: "record-digests" }), claim("skip", { id: "corpus-commitments" }), claim("pass", { id: "anchor-checkpoint" }), claim("skip", { id: "stats-parity" })] },
      });
      expect(buildVerificationReport([api, orb]).ok).toBe(true);
    });

    it("does not also report 'nothing verified' for a run that produced no report at all", () => {
      // One cause, one finding. A broken run trivially has no passing claims too.
      const report = buildVerificationReport([run({ report: null, exitCode: 1 })]);
      expect(report.body).toContain("no readable report");
      expect(report.body).not.toContain("nothing was verified");
    });
  });
});

describe("escapeCell", () => {
  it("neutralises pipes and newlines, which verifier details genuinely contain", () => {
    // A raw pipe silently splits a markdown cell and shifts every later column -- the failure detail would be
    // rendered as a different column's content.
    expect(escapeCell("a | b")).toBe("a \\| b");
    expect(escapeCell("line1\nline2")).toBe("line1 line2");
    expect(escapeCell("line1\r\nline2")).toBe("line1 line2");
  });
});

describe("parseRun", () => {
  it("parses a JSON report", () => {
    expect(parseRun("l", "u", 0, '{"results":[]}').report).toEqual({ results: [] });
  });

  it("never throws on unparseable or non-object output -- that IS a result", () => {
    expect(parseRun("l", "u", 1, "not json").report).toBeNull();
    expect(parseRun("l", "u", 1, "null").report).toBeNull();
    expect(parseRun("l", "u", 1, "42").report).toBeNull();
    expect(parseRun("l", "u", 1, "").report).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads four arguments per surface", () => {
    const runs = parseArgs(["public API", "https://a.test", "0", "a.json", "Orb", "https://b.test", "1", "b.json"], () => '{"results":[]}');
    expect(runs.map((entry) => [entry.label, entry.baseUrl, entry.exitCode])).toEqual([
      ["public API", "https://a.test", 0],
      ["Orb", "https://b.test", 1],
    ]);
  });

  it("treats an unreadable capture file as 'nothing was verified', not as an empty pass", () => {
    const runs = parseArgs(["l", "u", "0", "missing.json"], () => {
      throw new Error("ENOENT");
    });
    expect(runs[0]?.report).toBeNull();
    expect(buildVerificationReport(runs).ok).toBe(false);
  });

  it("treats a non-numeric exit code as a failure rather than an optimistic zero", () => {
    const runs = parseArgs(["l", "u", "", "a.json"], () => '{"results":[]}');
    expect(runs[0]?.exitCode).toBe(1);
  });
});

describe("renderGithubOutput", () => {
  it("emits the verdict BEFORE the heredoc, so the body cannot swallow it", () => {
    // The bug this shape exists to prevent: the workflow shell wrapping the script's stdout in a heredoc while
    // the script separately appended its scalars interleaved the two writers, putting VERIFY_OK inside the body
    // block. The workflow then read an empty verdict -- which is not "true" -- and filed an outage on a green
    // night. One writer, one ordering.
    const rendered = renderGithubOutput(buildVerificationReport([run({ report: { results: [claim("fail")] } })]));
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("VERIFY_OK=false");
    expect(lines[1]).toMatch(/^VERIFY_SUMMARY=/);
    expect(lines[2]).toBe(`body<<${OUTPUT_DELIMITER}`);
    expect(lines.at(-2)).toBe(OUTPUT_DELIMITER);
  });

  it("emits VERIFY_OK=true on a green run", () => {
    expect(renderGithubOutput(buildVerificationReport([run()]))).toContain("VERIFY_OK=true");
  });

  it("refuses to render a body containing the delimiter, rather than emitting an injectable block", () => {
    const poisoned = { ...buildVerificationReport([run()]), body: `x\n${OUTPUT_DELIMITER}\nVERIFY_OK=true` };
    expect(() => renderGithubOutput(poisoned)).toThrow(/output delimiter/);
  });
});

describe("runCli", () => {
  it("writes the outputs and reports success", () => {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = runCli(["public API", "https://a.test", "0", "a.json"], (chunk) => chunks.push(chunk), () => '{"results":[{"status":"pass","claim":"c","detail":"d"}]}');
    stdout.mockRestore();
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("VERIFY_OK=true");
  });

  it("still exits 0 when verification failed, so the tracking-issue step still runs", () => {
    // A non-zero exit here would abort the job before it could file the issue -- a monitor that notices a
    // problem and then drops it. The workflow reads VERIFY_OK and fails the run in its own last step.
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = runCli(["public API", "https://a.test", "1", "a.json"], (chunk) => chunks.push(chunk), () => "not json");
    stdout.mockRestore();
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("VERIFY_OK=false");
  });

  it("rejects an argument count that is not a multiple of four", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runCli(["only-one"], () => undefined, () => "")).toBe(2);
    expect(runCli([], () => undefined, () => "")).toBe(2);
    stderr.mockRestore();
  });
});
