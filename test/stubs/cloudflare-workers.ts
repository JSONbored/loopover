export class DurableObject {
  ctx: unknown;
  env: unknown;

  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  ctx: unknown;
  env: unknown;

  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export const exports = {};
export const env = {};
