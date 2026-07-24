// One throwaway RSA-2048 GitHub App private key per worker process (#test-hotspots): the suite
// re-generated a fresh WebCrypto keypair on every call — ~770 call sites × ~20-100ms of prime
// search — for JWTs whose signatures the fetch stubs never verify. Any single valid key is as good
// as any other for these fixtures, so one per process is memoized on globalThis (NOT module scope:
// vitest's per-file module isolation re-evaluates this module constantly, the same lesson
// test/helpers/d1.ts's template memo learned). github-app.test.ts's key-rotation tests need
// genuinely DISTINCT keys per call and keep their own local, non-memoized generator instead.
const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

async function freshPrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `${PEM_HEADER}\n${base64}\n${PEM_FOOTER}`;
}

export function generatePrivateKeyPem(): Promise<string> {
  const holder = globalThis as { __loopoverTestAppKeyPem?: Promise<string> };
  return (holder.__loopoverTestAppKeyPem ??= freshPrivateKeyPem());
}
