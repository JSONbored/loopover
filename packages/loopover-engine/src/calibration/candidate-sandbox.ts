// Untrusted candidate-agent sandbox policy (#9264, harness #9216, epic #8534) — the pure half.
//
// Candidate agents are untrusted BY CONSTRUCTION: arbitrary third-party code, submitted to be scored. Two
// facts drive everything here.
//
//   ATTESTATION IS NOT A SANDBOX. Attestation proves WHAT ran; it does nothing to constrain what that code
//   can reach while running. So every property below must hold with or without SNP hardware, and none of
//   them may be skipped because attestation is present. They are enforced by the container runtime, which
//   exists today, rather than waiting on the TEE fleet (#8535/#8536).
//
//   THE NETWORK IS THE WHOLE BALLGAME. A candidate agent that can reach the network can simply fetch the
//   realized future — the very outcomes it is being asked to predict — and score perfectly while having
//   learned nothing. #9259 leak-proofs the DATA; this module leak-proofs the RUNTIME. Both are required:
//   a perfect snapshot handed to a networked process is not a benchmark.
//
// This module is pure policy + honest labeling. It does not spawn anything: it produces the exact argument
// list a runner must use, and it decides what a completed run is allowed to CLAIM. Keeping those two pure
// means both are testable without a container runtime, and means the CLI cannot quietly weaken a limit — it
// has no limits of its own to weaken.
//
// ── THE LIMITS, AND WHY EACH ONE ─────────────────────────────────────────────────────────────────────
//   network: none        — see above. The single most important control here.
//   read-only rootfs     — a candidate cannot persist anything between work units, so it cannot accumulate
//                          state across a benchmark it is supposed to answer one unit at a time.
//   task input read-only — the frozen snapshot is mounted read-only, so an agent cannot edit the question.
//   no host filesystem   — no bind mounts beyond the read-only task input; nothing of ours is reachable.
//   non-root             — the runner image already creates uid 10001; running as it means a container
//                          escape lands as an unprivileged user rather than root on the host.
//   memory / cpu / wall  — bounded so one submission cannot deny service to the queue. Wall-clock matters
//                          most: an agent that never returns would otherwise hold a slot forever.
//   no new privileges    — blocks setuid escalation inside the container.
//   all capabilities dropped — a scoring run needs none of them.

/** Defaults, chosen to be generous for honest work and far too small to be useful for anything else. */
export const DEFAULT_CANDIDATE_LIMITS = {
  memoryMb: 2048,
  cpus: 2,
  wallClockSeconds: 600,
  pidsLimit: 256,
} as const;

export type CandidateResourceLimits = {
  memoryMb: number;
  cpus: number;
  wallClockSeconds: number;
  pidsLimit: number;
};

export type CandidateSandboxSpec = {
  image: string;
  /** Host path of the frozen snapshot (#9259). Mounted READ-ONLY at {@link CANDIDATE_TASK_MOUNT}. */
  taskInputPath: string;
  /** Host path the run writes its proposals to. The ONLY writable mount. */
  outputPath: string;
  limits?: Partial<CandidateResourceLimits> | undefined;
};

/** Where the frozen snapshot appears inside the container. Fixed, so a candidate agent's entrypoint can be
 *  written against a stable path and the runner never has to pass a configurable one it could be tricked
 *  into pointing elsewhere. */
export const CANDIDATE_TASK_MOUNT = "/task/snapshot.json";
export const CANDIDATE_OUTPUT_MOUNT = "/out/proposals.json";

export function resolveCandidateLimits(overrides?: Partial<CandidateResourceLimits> | undefined): CandidateResourceLimits {
  const limits = { ...DEFAULT_CANDIDATE_LIMITS, ...(overrides ?? {}) };
  // A non-positive or non-finite limit is a caller bug that would REMOVE a bound rather than set one, so it
  // falls back to the default instead of being honored. Failing open on a resource bound is the one
  // direction that cannot be allowed here.
  const sane = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    memoryMb: sane(limits.memoryMb, DEFAULT_CANDIDATE_LIMITS.memoryMb),
    cpus: sane(limits.cpus, DEFAULT_CANDIDATE_LIMITS.cpus),
    wallClockSeconds: sane(limits.wallClockSeconds, DEFAULT_CANDIDATE_LIMITS.wallClockSeconds),
    pidsLimit: sane(limits.pidsLimit, DEFAULT_CANDIDATE_LIMITS.pidsLimit),
  };
}

/**
 * The exact container arguments that enforce every property in this module's header.
 *
 * Returned as an array rather than a shell string on purpose: a string would have to be quoted by the
 * caller, and a snapshot path containing a space or a quote would then be a command-injection vector from
 * data we do not control. An argv array has no such seam.
 */
export function candidateSandboxArgs(spec: CandidateSandboxSpec): string[] {
  const limits = resolveCandidateLimits(spec.limits);
  return [
    "run",
    "--rm",
    // The control that matters most: no egress, so the realized future is unreachable.
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--user",
    "10001:10001",
    "--pids-limit",
    String(limits.pidsLimit),
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    // The task is mounted read-only: an agent may read the question and may not edit it.
    "--mount",
    `type=bind,source=${spec.taskInputPath},target=${CANDIDATE_TASK_MOUNT},readonly`,
    // The single writable path, and it is a bind of one file, not a directory of ours.
    "--mount",
    `type=bind,source=${spec.outputPath},target=${CANDIDATE_OUTPUT_MOUNT}`,
    spec.image,
  ];
}

/** What a runner observed about the isolation it actually established, as opposed to what it intended. */
export type EstablishedIsolation = {
  networkDisabled: boolean;
  rootfsReadOnly: boolean;
  taskInputReadOnly: boolean;
  nonRoot: boolean;
  limitsApplied: boolean;
  /** A structurally-valid attestation envelope was assembled AND its technology is genuine SNP/TDX
   *  hardware — not the sample attester. The runner decides this; this module only labels it. */
  genuineAttestation: boolean;
};

export type CandidateRunVerdict =
  | { scoreable: true; trustTier: "attested" | "reproducible" }
  | { scoreable: false; trustTier: null; failures: string[] };

/**
 * Decide whether a completed candidate run may be SCORED, and what it may claim.
 *
 * FAIL-CLOSED, matching the attested-run path's own posture: a run that could not establish its claimed
 * isolation does not score at all. It is not scored-and-flagged, and not scored at a lower tier — a
 * networked agent's score is not a weaker measurement of the same thing, it is a measurement of something
 * else entirely, and admitting it at any tier would put a fabricated number on the leaderboard.
 *
 * The tier is read from what was ESTABLISHED, never from what was configured: `attested` requires genuine
 * hardware attestation, and everything else is `reproducible`. There is deliberately no path by which
 * "the plumbing supports attestation" becomes an `attested` label.
 */
export function decideCandidateRunVerdict(established: EstablishedIsolation): CandidateRunVerdict {
  const failures: string[] = [];
  if (!established.networkDisabled) failures.push("network egress was not disabled — a candidate could fetch the realized future");
  if (!established.rootfsReadOnly) failures.push("root filesystem was not read-only — a candidate could persist state across work units");
  if (!established.taskInputReadOnly) failures.push("task input was not mounted read-only — a candidate could edit the question");
  if (!established.nonRoot) failures.push("container ran as root");
  if (!established.limitsApplied) failures.push("resource limits were not applied");
  if (failures.length > 0) return { scoreable: false, trustTier: null, failures };
  return { scoreable: true, trustTier: established.genuineAttestation ? "attested" : "reproducible" };
}

/** Render the limits as documentation rows — the issue asks for the limits AND the reasoning to be
 *  documented, and generating that from the same constants the runner uses is what keeps the doc from
 *  drifting away from what is actually enforced. */
export function describeCandidateLimits(limits: CandidateResourceLimits = resolveCandidateLimits()): Array<{ limit: string; value: string; why: string }> {
  return [
    { limit: "network", value: "none", why: "A candidate that can reach the network can fetch the realized future and score perfectly without predicting anything." },
    { limit: "rootfs", value: "read-only", why: "Prevents a candidate from persisting state between work units it is meant to answer independently." },
    { limit: "task input", value: "read-only bind", why: "A candidate may read the question and may not edit it." },
    { limit: "user", value: "10001:10001", why: "Non-root, so a container escape lands unprivileged rather than as root on the host." },
    { limit: "capabilities", value: "all dropped", why: "A scoring run needs none of them." },
    { limit: "privileges", value: "no-new-privileges", why: "Blocks setuid escalation inside the container." },
    { limit: "memory", value: `${limits.memoryMb} MiB`, why: "Bounded so one submission cannot exhaust the host and deny service to the queue." },
    { limit: "cpus", value: String(limits.cpus), why: "Bounded for the same reason, and so scoring throughput stays predictable." },
    { limit: "wall clock", value: `${limits.wallClockSeconds}s`, why: "An agent that never returns would otherwise hold a queue slot forever." },
    { limit: "pids", value: String(limits.pidsLimit), why: "Caps fork-bomb style resource exhaustion inside the container." },
  ];
}
