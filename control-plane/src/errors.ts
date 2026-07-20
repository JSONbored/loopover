// Control-plane error types (#7524). Keep messages operator-safe: no secrets, wallets, or raw tokens.

export type ControlPlaneErrorCode =
  | "invalid_tenant"
  | "invalid_product"
  | "container_create_failed"
  | "database_provision_failed"
  | "secrets_inject_failed"
  | "container_destroy_failed"
  | "database_destroy_failed"
  | "secrets_revoke_failed"
  | "rollback_failed";

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly causeError?: unknown;

  constructor(code: ControlPlaneErrorCode, message: string, causeError?: unknown) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.causeError = causeError;
  }
}

export function isControlPlaneError(value: unknown): value is ControlPlaneError {
  return value instanceof ControlPlaneError;
}
