import { describe, expect, it } from "vitest";
import { findMissingRedeliveryGuards } from "../../scripts/check-command-redelivery-guards";

/** Drives the checker off one string, mirroring check-dead-source-files-script.test.ts's own `fakeTree`. */
function fakeFile(contents: string) {
  return { file: "src/queue/processors.ts", readFile: () => contents, allowedWithoutGuard: new Map<string, string>() };
}

const GUARD = `  const redeliverySinceIso = new Date(Date.now() - COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS).toISOString();
  if (await hasAuditEventForDelivery(env, actor, "github_app.x", targetKey, deliveryId, redeliverySinceIso)) return true;`;

/** The one-line signature style — `maybeProcessResolveCommand`'s shape. */
function oneLineHandler(name: string, body: string): string {
  return `async function ${name}(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {\n${body}\n  return true;\n}`;
}

/** The five-line signature style — `maybeProcessGateOverrideCommand`'s shape. */
function multiLineHandler(name: string, body: string): string {
  return `async function ${name}(\n  env: Env,\n  deliveryId: string,\n  payload: GitHubWebhookPayload,\n): Promise<boolean> {\n${body}\n  return true;\n}`;
}

// #9563: three handlers in this family shipped without #9312's redelivery guard — one writing duplicate
// permanent review-memory suppression rows, two spending a second paid model call. They were missed because
// the family is written in two different signature formattings, so a grep for either shape sees only half of
// it. That is the mechanical cause, and it is what this checker exists to remove.
describe("check-command-redelivery-guards script", () => {
  it("REGRESSION: flags an unguarded ONE-LINE-signature handler — the maybeProcessResolveCommand shape", () => {
    const violations = findMissingRedeliveryGuards(fakeFile(oneLineHandler("maybeProcessThingCommand", "  const x = 1;")));
    expect(violations).toEqual([{ file: "src/queue/processors.ts", line: 1, handler: "maybeProcessThingCommand" }]);
  });

  it("REGRESSION: flags an unguarded MULTI-LINE-signature handler — the maybeProcessGateOverrideCommand shape", () => {
    // The whole point of normalizing whitespace: a checker that only understood the one-line form would have
    // missed gate-override and both panel handlers, i.e. every offender except one.
    const violations = findMissingRedeliveryGuards(fakeFile(multiLineHandler("maybeProcessOtherCommand", "  const x = 1;")));
    expect(violations).toEqual([{ file: "src/queue/processors.ts", line: 1, handler: "maybeProcessOtherCommand" }]);
  });

  it("INVARIANT: a guarded handler is not flagged, in either signature style", () => {
    expect(findMissingRedeliveryGuards(fakeFile(oneLineHandler("maybeProcessGuardedCommand", GUARD)))).toEqual([]);
    expect(findMissingRedeliveryGuards(fakeFile(multiLineHandler("maybeProcessGuardedCommand", GUARD)))).toEqual([]);
  });

  it("INVARIANT: a neighbour's guard does NOT satisfy the scan — bodies are bounded by brace depth, not a line window", () => {
    // This is the false-negative class that actually happened while check-regate-sort-key.ts was being
    // written. With handlers 30–470 lines long and packed adjacently, a fixed window would let the guarded
    // handler above cover for the unguarded one below, and the check would report a clean tree while the bug
    // it exists to catch sat two functions away.
    const source = [oneLineHandler("maybeProcessGuardedCommand", GUARD), oneLineHandler("maybeProcessLeakyCommand", "  const x = 1;")].join("\n\n");
    expect(findMissingRedeliveryGuards(fakeFile(source)).map((violation) => violation.handler)).toEqual(["maybeProcessLeakyCommand"]);

    // ...and in the other order, so this pins brace-bounding rather than "only ever looks forward".
    const reversed = [oneLineHandler("maybeProcessLeakyCommand", "  const x = 1;"), oneLineHandler("maybeProcessGuardedCommand", GUARD)].join("\n\n");
    expect(findMissingRedeliveryGuards(fakeFile(reversed)).map((violation) => violation.handler)).toEqual(["maybeProcessLeakyCommand"]);
  });

  it("INVARIANT: a nested block inside the body does not end the scan early", () => {
    // Depth tracking has to survive `if {}` / `try {}` before the guard: an early exit would read the handler
    // as unguarded and produce a false POSITIVE, which is how a check like this gets disabled.
    const body = `  if (cond) {\n    return false;\n  }\n  try {\n    doThing();\n  } catch {\n    /* ignore */\n  }\n${GUARD}`;
    expect(findMissingRedeliveryGuards(fakeFile(oneLineHandler("maybeProcessNestedCommand", body)))).toEqual([]);
  });

  it("INVARIANT: an allowlisted handler is exempt, but only by EXACT name", () => {
    const source = [oneLineHandler("maybeProcessSafeCommand", "  const x = 1;"), oneLineHandler("maybeProcessSafeCommandTwin", "  const x = 1;")].join("\n\n");
    const allowed = new Map([["maybeProcessSafeCommand", "idempotent in-place comment update"]]);
    const violations = findMissingRedeliveryGuards({ ...fakeFile(source), allowedWithoutGuard: allowed });
    // The twin is NOT covered by its prefix-sharing sibling's entry — an exemption is a statement about one
    // handler, and a substring match would silently widen it to whatever gets named next.
    expect(violations.map((violation) => violation.handler)).toEqual(["maybeProcessSafeCommandTwin"]);
  });

  it("INVARIANT: only the webhook family's signature is scanned — a same-prefix helper is ignored", () => {
    // `maybeProcess*` is a broad prefix in this file. Scanning everything that matches it would flag pure
    // helpers that never see a deliveryId and cannot be redelivered at all.
    const source = [
      "async function maybeProcessSomething(env: Env, prNumber: number): Promise<boolean> {\n  return true;\n}",
      "function maybeProcessSync(input: string): boolean {\n  return true;\n}",
    ].join("\n\n");
    expect(findMissingRedeliveryGuards(fakeFile(source))).toEqual([]);
  });

  it("INVARIANT: a trailing-comma parameter list matches too — both formattings occur in the real file", () => {
    expect(findMissingRedeliveryGuards(fakeFile(multiLineHandler("maybeProcessCommaCommand", "  const x = 1;"))).length).toBe(1);
  });

  it("reports violations sorted by line, so the failure output is stable across runs", () => {
    const source = [
      oneLineHandler("maybeProcessAlphaCommand", "  const x = 1;"),
      oneLineHandler("maybeProcessBetaCommand", "  const x = 1;"),
      oneLineHandler("maybeProcessGammaCommand", "  const x = 1;"),
    ].join("\n\n");
    const violations = findMissingRedeliveryGuards(fakeFile(source));
    expect(violations.map((violation) => violation.handler)).toEqual(["maybeProcessAlphaCommand", "maybeProcessBetaCommand", "maybeProcessGammaCommand"]);
    expect(violations.map((violation) => violation.line)).toEqual([1, 6, 11]);
  });

  it("the REAL repo tree is clean — this check runs in CI and must stay green", () => {
    expect(findMissingRedeliveryGuards()).toEqual([]);
  });
});
