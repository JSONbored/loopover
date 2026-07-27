# Attested-run verifier

The third-party-trust half of the attested-evaluation epic (#8534, issue #9212): given a published
attestation envelope, answer *"did this exact code run on this exact corpus inside genuine AMD SEV-SNP
hardware?"* — without contacting LoopOver, without any hardware of your own, and without trusting anyone's
say-so beyond AMD's own published root keys.

## What this verifies

```sh
npx tsx scripts/verify-attested-run.ts \
  --envelope envelope.json --expected expected.json \
  --vcek-cert vcek.pem \
  [--ask-cert ask.pem] [--ark-cert ark.pem] [--product milan|genoa] \
  [--allow-sample]
```

- **`envelope.json`** — the published `AttestationEnvelope` (the shape `assembleAttestationEnvelope`
  produces: `schemaVersion`, `teeTechnology`, `runtimeClass`, `measurement`, `reportData`, `runId`,
  `attestationReport` (base64), `verification`). Where you got this file from — a public API, a maintainer
  who sent it to you — is outside this tool's scope; see #9186 (the unified tenant verification contract)
  for how a real deployment is meant to publish one.
- **`expected.json`** — *your own* pinned expectations: `{ "measurement": "<hex>", "corpusChecksum": "<hex>",
  "headSha": "<hex>", "baseSha": "<hex>" }`. This is deliberately separate from
  `scripts/replay-runner-image-manifest.json` (#9214's *image*-reproducibility manifest) — this file is
  about what one specific run is expected to have produced, not about the image that produced it.
- **`--vcek-cert`** — the VCEK certificate for the chip that produced the report. Supply it directly, or pass
  **`--fetch-vcek`** to fetch it live from AMD's KDS (`kdsintf.amd.com`) using the chip ID and TCB values read
  out of the report itself. **Off by default** — a verifier that silently phones home on every check would be
  a real privacy/trust regression for a tool whose whole point is working without contacting anyone.
- **`--ask-cert`/`--ark-cert`** — default to this repo's own vendored Milan certificates
  (`certs/milan-{ask,ark}.pem`); pass `--product genoa` to use the vendored Genoa pair instead, or point at
  your own copies with these flags.

The checks, in the order they actually run (see `scripts/verify-attested-run-core.ts`'s own header comment
for why the order itself is a security property, not an implementation detail):

1. **Sample-attester rejection** — a `LOOPOVER-SAMPLE-ATTESTATION-v1`-tagged envelope (the dev artifact
   `createSampleAttester` produces, per #9211) fails immediately unless `--allow-sample` is passed.
2. **Envelope structure** — the envelope must match `AttestationEnvelope`'s own shape exactly
   (`validateAttestationEnvelope`, from #8541).
3. **Report structure** — the decoded `attestationReport` must parse as a genuine 1184-byte SEV-SNP
   `ATTESTATION_REPORT` using `ECDSA-P384-SHA384` (the only signature algorithm this tool recognizes).
4. **Certificate chain of trust** — the supplied ARK must be byte-identical to the vendored, pinned root (not
   merely "any self-signed certificate"), the ARK must genuinely be self-signed, the ASK must genuinely be
   signed by that ARK, and the VCEK must genuinely be signed by that ASK. Every link is a real X.509
   signature verification (`X509Certificate.verify`), never a name/metadata-only match.
5. **Report signature** — the report's own ECDSA-P384-SHA384 signature must verify against the
   now-trusted VCEK's public key. **Nothing about the report's content (below) is trusted until this passes**
   — a forged report with a plausible-looking measurement is still rejected here, at the signature, not
   coincidentally waved through by the content checks that follow.
6. **TCB status** — the four SVN values (bootloader/TEE/SNP/microcode) encoded in the VCEK certificate's AMD
   KDS extensions must match the report's own `reported_tcb` field exactly.
7. **Measurement** — the report's launch measurement must equal `expected.json`'s pinned value.
8. **`report_data`** — re-derived from `expected.json`'s `corpusChecksum`/`headSha`/`baseSha` plus the
   envelope's own `runId` (via `@loopover/engine`'s `buildAttestationReportData`, the same function that
   produced it) and compared against the report's own 64-byte `report_data` field.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Verified. |
| 1 | `sample_attestation` |
| 2 | `envelope_invalid` |
| 3 | `malformed_report` |
| 4 | `chain_untrusted` |
| 5 | `signature_invalid` |
| 6 | `tcb_mismatch` |
| 7 | `measurement_mismatch` |
| 8 | `report_data_mismatch` |
| 9 | Usage or IO error (bad arguments, an unreadable file, a failed KDS request) — distinct from every attestation-content failure above, since it says nothing about whether the run itself was genuine. |

## Byte layout and cryptography, and where it comes from

Every report field offset, the ECDSA signature's on-the-wire byte order, and the AMD KDS extension OIDs this
tool reads are taken from — and were cross-checked against — [google/go-sev-guest](https://github.com/google/go-sev-guest),
a maintained, production attestation-verification library, **not derived from memory of AMD's PDF ABI spec
alone**. See each module's own header comment (`verify-attested-run-report.ts`, `verify-attested-run-der.ts`,
`verify-attested-run-core.ts`) for the specific function/file cross-referenced. The OID encoding and the X.509
extension-walking logic were additionally verified byte-for-byte against a real, live-fetched AMD certificate
during development (see `verify-attested-run-der.ts`'s test suite).

This CLI deliberately hand-parses DER rather than depending on a general ASN.1 library: the trusted computing
base of a tool whose entire purpose is "verify without trusting anyone" should itself be small and
auditable, not delegate that same trust to an unaudited third-party parser.

## Vendored certificates

`certs/{milan,genoa}-{ark,ask}.pem` were fetched directly from AMD's own KDS:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://kdsintf.amd.com/vcek/v1/Milan/cert_chain -o milan-cert_chain.pem
curl --proto '=https' --tlsv1.2 -sSf https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain -o genoa-cert_chain.pem
```

Each `cert_chain` response is the ASK certificate followed by the ARK certificate, concatenated PEM; split on
`-----BEGIN CERTIFICATE-----` to separate them. Refresh these only if AMD rotates a product line's root —
verify a freshly-fetched ARK is still self-signed and byte-identical in its public key before replacing the
vendored copy, never merely trust that a same-named download is the same certificate.

## What this tool does NOT verify

- **The live decision path.** This tool verifies an attested *backtest replay*. Attesting the live gate's
  actual decision-making path was deliberately deferred (#9141) — attestation proves computation, not the
  decision record's own provenance, and the anchoring + complete-records work elsewhere in the trust stack
  closes the practical gap more cheaply. `verify-this-review.mdx` states this boundary for the public-facing
  story; `#8538` extends that walkthrough to point at this CLI specifically.
- **That the reproducible image (#9214) is what actually produced this report.** This tool checks the
  *report's* own cryptographic claims; correlating a specific report to a specific, independently-rebuildable
  image build is `scripts/replay-runner-image-manifest.json`'s job, a separate (already-shipped) piece of the
  trust stack.
- **CRL/revocation status.** AMD publishes a CRL per product line (`https://kdsintf.amd.com/vcek/v1/{product}/crl`);
  this tool does not fetch or consult it. A chip whose VCEK has been revoked (a known-compromised part) would
  still pass this tool's checks today. Track this as a real, open gap — file it against epic #8534 if it
  becomes load-bearing rather than assuming it's silently covered here.
