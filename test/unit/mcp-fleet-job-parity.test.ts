import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTERNAL_JOB_NAMES, INTERNAL_JOB_SPEC } from "@loopover/contract/enums";

// #9522: `loopover_fleet_run_job` replaces ~30 bespoke per-job tools with one closed enum. The contract
// package cannot import src/, so that enum is a transcription of the live route table — and a transcription
// is only safe while something checks it. This is that check, in both directions.
//
// The type side is checked separately and at COMPILE time: src/mcp/server.ts assigns every declared
// messageType to `JobMessage["type"] | null`, so a message the dispatcher does not handle fails the build.

const ROUTES = readFileSync(join(process.cwd(), "src/api/routes.ts"), "utf8");

/** Every `/v1/internal/jobs/<name>` route in the live table, and which modes it exposes. */
function liveJobRoutes(): Map<string, Set<"enqueue" | "run">> {
  const routes = new Map<string, Set<"enqueue" | "run">>();
  for (const match of ROUTES.matchAll(/"\/v1\/internal\/jobs\/([a-z0-9-]+)(\/run)?"/g)) {
    const name = match[1]!;
    if (!routes.has(name)) routes.set(name, new Set());
    routes.get(name)!.add(match[2] ? "run" : "enqueue");
  }
  return routes;
}

describe("loopover_fleet_run_job ↔ the live job route table (#9522)", () => {
  it("declares EVERY job route — nothing excluded", () => {
    const live = liveJobRoutes();
    expect([...INTERNAL_JOB_NAMES].sort()).toEqual([...live.keys()].sort());
  });

  it("declares no job the route table does not have — a removed route must not stay callable", () => {
    const live = liveJobRoutes();
    const phantom = INTERNAL_JOB_NAMES.filter((name) => !live.has(name));
    expect(phantom, `declared jobs with no route: ${phantom.join(", ")}`).toEqual([]);
  });

  it("records each job's real modes, so an unsupported pairing is answered rather than 404'd", () => {
    const live = liveJobRoutes();
    for (const job of INTERNAL_JOB_NAMES) {
      expect([...INTERNAL_JOB_SPEC[job].modes].sort(), `${job}'s modes`).toEqual([...live.get(job)!].sort());
    }
  });

  it("records the queue message type each enqueue route actually sends, which is not always the path", () => {
    // The trap this exists for: rag-index sends `rag-index-repo` and regate-pr sends `agent-regate-pr`.
    // Deriving the message from the job NAME would enqueue something the dispatcher silently drops.
    const routes = readFileSync(join(process.cwd(), "src/api/routes.ts"), "utf8");
    for (const job of INTERNAL_JOB_NAMES) {
      const spec = INTERNAL_JOB_SPEC[job];
      const modes: readonly string[] = spec.modes;
      if (!modes.includes("enqueue")) {
        expect(spec.messageType, `${job} has no enqueue route, so it must declare messageType: null`).toBeNull();
        continue;
      }
      const handler = new RegExp(`app\\.post\\("/v1/internal/jobs/${job}", async \\(c\\) => \\{(.*?)\\n {2}\\}\\);`, "s").exec(routes);
      expect(handler, `${job}'s enqueue route should be findable`).not.toBeNull();
      const sent = /type: "([a-z0-9-]+)"/.exec(handler![1]!)?.[1];
      expect(spec.messageType, `${job} enqueues "${sent}"`).toBe(sent);
    }
  });

  it("every declared job offers at least one mode", () => {
    for (const job of INTERNAL_JOB_NAMES) {
      expect(INTERNAL_JOB_SPEC[job].modes.length, `${job} declares no modes`).toBeGreaterThan(0);
    }
  });

  it("every run-only job has an inline runner wired in the server — none silently unreachable", () => {
    const server = readFileSync(join(process.cwd(), "src/mcp/server.ts"), "utf8");
    const runOnly = INTERNAL_JOB_NAMES.filter((job) => INTERNAL_JOB_SPEC[job].messageType === null);
    expect(runOnly.length, "the run-only set should not be empty").toBeGreaterThan(0);
    for (const job of runOnly) {
      expect(server, `${job} is run-only and needs a RUN_ONLY_JOBS entry`).toContain(`"${job}":`);
    }
  });
});
