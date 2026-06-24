// Self-host module-resolution hooks (run before the app loads). Any `cloudflare:*` import — from gittensory's
// source OR a transitive dep (@cloudflare/puppeteer, the agents SDK / partyserver) — resolves to an in-memory
// stub. These bindings are never USED on self-host (BROWSER/RATE_LIMITER/email absent → the code degrades
// before touching them); the stub only makes the import + any `extends`/named import resolve so Node can load
// the graph. Used as the Docker entry: `node --import ./scripts/register-selfhost.mjs dist/server.mjs`.
import { registerHooks } from "node:module";

const STUB_SOURCE = [
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "export class RpcTarget {}",
  "export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }",
  "export const env = {};",
  "export const WorkerVersionMetadata = {};",
  "export function connect() { throw new Error('cloudflare:sockets is unavailable on the self-host runtime'); }",
  "export default {};",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("cloudflare:")) return { url: `cfstub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("cfstub:")) return { format: "module", shortCircuit: true, source: STUB_SOURCE };
    return nextLoad(url, context);
  },
});
