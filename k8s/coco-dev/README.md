# CoCo dev stack — metal prep (#9213, epic #8534)

Everything about the eventual attested-evaluation stack *except the TEE itself* can be built and rehearsed
today, on ordinary hardware, using the [Confidential Containers](https://github.com/confidential-containers)
project's own no-hardware "dev/sample" mode. This directory is that rehearsal: committed manifests, pinned
versions, and a recorded topology decision, so that [#8536](https://github.com/JSONbored/loopover/issues/8536)
(the same stack on real AMD SEV-SNP metal) is a config apply plus measurement recording — no net-new design.

## What's here

```
k8s/coco-dev/
  versions.json                  -- pinned CoCo Helm chart + Trustee KBS versions (single source of truth;
                                     scripts/check-coco-dev-versions.ts fails CI if kustomization.yaml drifts
                                     from this file)
  helm/values-coco-dev.yaml      -- dev-only override: disables the SNP/TDX/GPU shims, keeps only the no-
                                     hardware `qemu-coco-dev` shim
  kbs/base/, kbs/overlays/dev/   -- Trustee KBS kustomize manifests, vendored from
                                     confidential-containers/trustee's own kbs/config/kubernetes/, digest-
                                     pinned instead of tag-pinned
  scripts/up.sh, down.sh         -- idempotent bring-up/teardown (kind cluster + Helm chart + KBS)
  scripts/generate-kbs-keys.sh   -- generates the local-only KBS admin keypair + dev workload secret,
                                     mirroring upstream's own deploy-kbs.sh; never committed (see .gitignore)
```

## What was actually verified, and where

Run against a real local `kind` cluster (Apple Silicon, arm64 — this repo's own dev machine) during this
issue's implementation:

- `kind create cluster` — a real Kubernetes control plane comes up.
- `helm upgrade --install coco oci://ghcr.io/confidential-containers/charts/confidential-containers --version
  0.21.0 -f helm/values-coco-dev.yaml` — installs cleanly; `kubectl get runtimeclass` shows
  `kata-qemu-coco-dev` and its siblings created for real.
- `kubectl apply -k kbs/overlays/dev` — the KBS namespace, ConfigMap, Secrets, Service, and Deployment all
  apply and the pod schedules.
- `npx tsx scripts/attested-backtest-run.ts --attester sample ...` (the attested-run harness, #9211) — runs
  to completion and returns `{ "status": "attested", "attesterKind": "sample", ... }`, exit code 0. This path
  needs no Kubernetes/Kata/KBS at all (that's the whole design point of the sample attester, see
  `scripts/attested-backtest-run.ts`'s own header comment) and was verified standalone.

**Not achievable on this dev machine, for a real and structural reason, not a bug:** both the published
Trustee KBS image and kata-deploy's own dev-shim daemonset images are built `amd64`/`s390x` only — no `arm64`
manifest exists. The KBS pod sits in `ImagePullBackOff` on this cluster
(`no match for platform in manifest: not found`), and `kata-as-coco-runtime`'s daemonset shows `0` ready, for
the identical reason. Loading a pre-pulled, emulated (`docker pull --platform linux/amd64`) copy of the image
directly into the kind node via `kind load docker-image` does **not** work around this: the CRI image service
still rejects the pull by platform even for content already resident on the node, regardless of
`imagePullPolicy`. This is the same class of environmental boundary as SNP hardware itself or `/dev/kvm` for
real Kata sandboxing (documented for those, e.g. in `scripts/verify-attested-run/README.md`) — a fact about
this machine's architecture, not something to route around. **Anyone running `scripts/up.sh` on a real amd64
Linux host** (which is what production/#8536 actually targets) hits none of this: the images pull and run
natively.

We deliberately did **not** add a recurring CI job to get a green run of the blocked half on GitHub-hosted
(amd64) runners, and did **not** stand up a self-hosted runner for it. `versions.json` changes rarely and
deliberately; the per-PR `coco-dev-versions:check` drift check already catches the one failure mode that
actually recurs (a version bumped in one file but not the other). A heavyweight, kind-cluster-plus-image-pull
job re-run on every push to main for a stack this static isn't proportional to that risk, and a self-hosted
runner is ongoing infrastructure and public-repo attack surface to secure indefinitely for the same modest
payoff. If a maintainer wants to fully exercise this stack, `scripts/up.sh` runs the identical, real commands
on any amd64 Linux host or VM (see `scripts/generate-kbs-keys.sh` for the one manual prerequisite).

## Topology decision: Trustee/KBS-mediated, not direct attestation-agent → verifier-CLI

Two ways a guest workload's attestation evidence can reach a verifier:

1. **Trustee/KBS-mediated** (what's vendored here): the guest's attestation-agent talks to a KBS, which runs
   the verification (via its built-in Attestation Service) and, only on success, releases a secret the guest
   needs to do its job. The **secret release is gated on verification** — a guest that can't attest gets
   nothing, enforced by infrastructure the guest itself can't bypass.
2. **Direct attestation-agent → verifier-CLI**: the guest (or something watching it) hands its raw
   attestation report to `scripts/verify-attested-run.ts` (#9212) directly; nothing is gated on the result
   unless something else chooses to act on the CLI's exit code.

**Decision: KBS-mediated.** Reasons:

- **Real secrets exist on this path.** The attested workload needs an actual DB credential / signing key to
  do its job (record an attested-run outcome, sign a result) — this is not attestation for attestation's own
  sake. A KBS is *specifically* the component whose job is "hold a secret, release it only after verifying
  the requester," which is exactly the shape of that need. A direct CLI-only flow would still need something
  else to hold and gate that secret — reinventing a narrower, unaudited KBS instead of using the project's
  own maintained one.
- **Fail-closed by construction, not by convention.** Under direct-verifier-CLI, "gate on the result" is a
  policy someone has to remember to implement and can't easily audit from outside. Under KBS-mediation, an
  unattested guest has no secret and therefore cannot proceed, full stop — the gate is structural, not just
  a check someone remembered to call.
- **`scripts/verify-attested-run.ts` (#9212) is not made redundant by this decision.** It stays the tool a
  *third party*, outside LoopOver's own infrastructure and holding none of its secrets, uses to independently
  re-verify a published envelope after the fact — a different audience and a different trust question
  ("should I, an outsider, believe this run happened") than "should the KBS release this specific secret to
  this specific guest right now." Both paths matter; they answer different questions for different parties.
- **Cost is bounded and already paid.** The KBS is one more component to deploy and pin (done here), but
  Trustee is the project's own maintained, documented answer to exactly this problem — not a bespoke one this
  repo would otherwise have to build and keep secure itself.

## Recording real launch measurements once SNP hardware arrives (#8536)

Today, `scripts/attested-backtest-run.ts --attester sample` never claims a measurement (the sample attester's
whole point is being self-labeling and unable to lie about being real evidence — see
`scripts/verify-attested-run-core.ts`'s `sample_attestation` rejection). On real hardware:

1. Deploy the **same** `k8s/coco-dev/kbs/` manifests plus a values override enabling the real `qemu-snp` shim
   in place of `qemu-coco-dev` (mechanically: swap which shim is `enabled: true` in a values file structured
   like `helm/values-coco-dev.yaml` — the chart, version, and every other setting stay identical).
2. Launch the pinned replay-runner image (`scripts/replay-runner/Dockerfile`, #9214) under the real
   `kata-qemu-snp` RuntimeClass. The hypervisor computes the launch measurement from the actual guest firmware
   + kernel + initrd + rootfs it launched — this is **not** a value LoopOver computes or asserts; it is what
   makes measurement pinning meaningful evidence rather than a self-report.
3. Capture that measurement from the first genuine attestation report obtained via `scripts/snp-attester.ts`
   (#9211) — read `attestationReport`'s `measurement` field (see `scripts/verify-attested-run-report.ts` for
   the exact offset) — and record it as `expected.json`'s `measurement` field for
   `scripts/verify-attested-run.ts` (#9212), and/or as a new pinned constant wherever the live gate's own
   fail-closed check (`--runtime-claim tee`, `scripts/attested-backtest-run-core.ts`) needs to compare against
   it.
4. Re-derive that measurement on every subsequent image rebuild by re-running step 2 against the newly built,
   digest-pinned image (`scripts/replay-runner-image-manifest.json`, #9214) and diffing — an *unexpected*
   measurement change with no corresponding image change is itself a signal worth investigating, not
   something to silently re-pin.

This plan needs no new design work once hardware exists — it is "run the thing that's already built, once,
under the real shim, and copy a number out of a report."
