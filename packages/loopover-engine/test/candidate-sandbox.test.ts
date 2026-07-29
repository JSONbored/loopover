import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANDIDATE_OUTPUT_MOUNT,
  CANDIDATE_TASK_MOUNT,
  candidateSandboxArgs,
  decideCandidateRunVerdict,
  DEFAULT_CANDIDATE_LIMITS,
  describeCandidateLimits,
  resolveCandidateLimits,
  type EstablishedIsolation,
} from "../dist/index.js";

// #9264 (harness #9216, epic #8534): candidate agents are untrusted by construction. Two properties carry
// the weight here and both are asserted directly: the sandbox args really do encode every claimed control
// (attestation is not a sandbox, so these must hold with or without SNP hardware), and the run verdict is
// FAIL-CLOSED — a run that could not establish its isolation does not score at any tier.

const SPEC = { image: "loopover/replay-runner:pinned", taskInputPath: "/host/snapshot.json", outputPath: "/host/out.json" };

/** Everything established — the baseline a test then breaks one property at a time from. */
const FULLY_ISOLATED: EstablishedIsolation = {
  networkDisabled: true,
  rootfsReadOnly: true,
  taskInputReadOnly: true,
  nonRoot: true,
  limitsApplied: true,
  genuineAttestation: false,
};

/** Adjacent argv pair lookup — the args are a flat array, so a flag's value is the element after it. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test("REGRESSION: the sandbox args encode EVERY claimed control, network first", () => {
  const args = candidateSandboxArgs(SPEC);
  // The control that matters most: a candidate that can reach the network fetches the realized future.
  assert.equal(valueOf(args, "--network"), "none");
  assert.ok(args.includes("--read-only"), "root filesystem must be read-only");
  assert.equal(valueOf(args, "--security-opt"), "no-new-privileges");
  assert.equal(valueOf(args, "--cap-drop"), "ALL");
  assert.equal(valueOf(args, "--user"), "10001:10001");
  assert.equal(valueOf(args, "--memory"), `${DEFAULT_CANDIDATE_LIMITS.memoryMb}m`);
  assert.equal(valueOf(args, "--cpus"), String(DEFAULT_CANDIDATE_LIMITS.cpus));
  assert.equal(valueOf(args, "--pids-limit"), String(DEFAULT_CANDIDATE_LIMITS.pidsLimit));
  // The image is the last argument, so nothing this function adds can be parsed as the image name.
  assert.equal(args[args.length - 1], SPEC.image);
});

test("REGRESSION: the task input is mounted READ-ONLY and the output is the only writable path", () => {
  const args = candidateSandboxArgs(SPEC);
  const mounts = args.filter((_, index) => args[index - 1] === "--mount");
  const taskMount = mounts.find((mount) => mount.includes(CANDIDATE_TASK_MOUNT));
  const outputMount = mounts.find((mount) => mount.includes(CANDIDATE_OUTPUT_MOUNT));
  assert.ok(taskMount?.endsWith(",readonly"), `task mount must be readonly, got ${taskMount}`);
  assert.ok(taskMount?.includes(`source=${SPEC.taskInputPath}`));
  // Exactly one writable mount, and it is a single output file rather than a directory of ours.
  assert.ok(outputMount && !outputMount.includes("readonly"), "output must be writable");
  assert.equal(mounts.filter((mount) => !mount.includes("readonly")).length, 1);
  // No host filesystem beyond those two.
  assert.equal(mounts.length, 2);
});

test("the args are an argv ARRAY, so a path containing shell metacharacters is inert", () => {
  // A snapshot path is data we do not fully control. As a shell string this would be an injection seam;
  // as argv elements it is just a (weird) path.
  const hostile = { ...SPEC, taskInputPath: "/host/a b'; rm -rf /; echo '.json" };
  const args = candidateSandboxArgs(hostile);
  const taskMount = args.find((arg) => arg.includes(CANDIDATE_TASK_MOUNT));
  assert.ok(taskMount?.includes(hostile.taskInputPath), "the path travels verbatim as one argv element");
  // It is ONE element, not split into several — nothing became a separate flag.
  assert.equal(args.filter((arg) => arg === "rm").length, 0);
});

test("INVARIANT: a non-positive or non-finite limit falls back to the default — a bound never fails OPEN", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const resolved = resolveCandidateLimits({ memoryMb: bad, cpus: bad, wallClockSeconds: bad, pidsLimit: bad });
    assert.deepEqual(resolved, { ...DEFAULT_CANDIDATE_LIMITS }, `limit ${String(bad)} must not remove the bound`);
  }
  // A genuine override is honored in both directions.
  const tightened = resolveCandidateLimits({ memoryMb: 512, wallClockSeconds: 60 });
  assert.equal(tightened.memoryMb, 512);
  assert.equal(tightened.wallClockSeconds, 60);
  assert.equal(tightened.cpus, DEFAULT_CANDIDATE_LIMITS.cpus, "unspecified limits keep their default");
  // Absent overrides resolve to the documented defaults.
  assert.deepEqual(resolveCandidateLimits(), { ...DEFAULT_CANDIDATE_LIMITS });
  assert.deepEqual(resolveCandidateLimits(undefined), { ...DEFAULT_CANDIDATE_LIMITS });
});

test("REGRESSION (fail-closed): a run missing ANY isolation property does not score, at any tier", () => {
  const properties = ["networkDisabled", "rootfsReadOnly", "taskInputReadOnly", "nonRoot", "limitsApplied"] as const;
  for (const property of properties) {
    const verdict = decideCandidateRunVerdict({ ...FULLY_ISOLATED, [property]: false });
    assert.equal(verdict.scoreable, false, `${property} missing must not score`);
    // Not scored-at-a-lower-tier: there is no tier at all, because the number would measure something else.
    assert.equal(verdict.trustTier, null);
    assert.ok(verdict.scoreable === false && verdict.failures.length === 1, `${property} should name exactly one failure`);
  }
  // Every failure is named at once, so an operator fixes the runner in one pass.
  const broken = decideCandidateRunVerdict({
    networkDisabled: false,
    rootfsReadOnly: false,
    taskInputReadOnly: false,
    nonRoot: false,
    limitsApplied: false,
    genuineAttestation: true, // even WITH attestation — attestation is not a sandbox
  });
  assert.equal(broken.scoreable, false);
  assert.ok(broken.scoreable === false && broken.failures.length === 5);
  assert.ok(broken.scoreable === false && broken.failures[0]?.includes("realized future"));
});

test("REGRESSION: the tier comes from what was ESTABLISHED — 'attested' is never assumed from plumbing", () => {
  const unattested = decideCandidateRunVerdict(FULLY_ISOLATED);
  assert.deepEqual(unattested, { scoreable: true, trustTier: "reproducible" });
  const attested = decideCandidateRunVerdict({ ...FULLY_ISOLATED, genuineAttestation: true });
  assert.deepEqual(attested, { scoreable: true, trustTier: "attested" });
  // A fully-isolated run WITHOUT genuine hardware is honestly `reproducible`, never upgraded because the
  // rest of the sandbox was perfect.
  assert.notEqual(unattested.trustTier, "attested");
});

test("the documented limits are generated FROM the enforced constants, so the doc cannot drift", () => {
  const rows = describeCandidateLimits();
  assert.ok(rows.length >= 10, "every control is documented");
  const memory = rows.find((row) => row.limit === "memory");
  assert.equal(memory?.value, `${DEFAULT_CANDIDATE_LIMITS.memoryMb} MiB`);
  // Every row carries a reason, not just a value — the issue asks for the reasoning, not a table of numbers.
  for (const row of rows) assert.ok(row.why.length > 20, `${row.limit} needs a real rationale`);
  // A tightened policy is described with the TIGHTENED numbers, proving the generation is real.
  const tightened = describeCandidateLimits(resolveCandidateLimits({ memoryMb: 256 }));
  assert.equal(tightened.find((row) => row.limit === "memory")?.value, "256 MiB");
});
