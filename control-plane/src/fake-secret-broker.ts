// In-memory `TenantSecretBroker` for control-plane tests (#7524). Records enrollments by id and
// secretType the same way #7174's broker column distinguishes mint strategies — without Worker Env.

import {
  type TenantSecretBroker,
  type TenantSecretBrokerIssueInput,
  type TenantSecretBrokerIssueResult,
  type TenantSecretBrokerRevokeResult,
} from "./secret-broker.js";

export type FakeSecretBrokerEnrollment = {
  enrollId: string;
  tenantId: string;
  product: string;
  secretType: string;
  revoked: boolean;
};

export type FakeTenantSecretBroker = TenantSecretBroker & {
  readonly enrollments: ReadonlyMap<string, FakeSecretBrokerEnrollment>;
  reset(): void;
};

export function createFakeTenantSecretBroker(
  options: { idPrefix?: string; sequence?: { next: number } } = {},
): FakeTenantSecretBroker {
  const enrollments = new Map<string, FakeSecretBrokerEnrollment>();
  const sequence = options.sequence ?? { next: 1 };
  const idPrefix = options.idPrefix ?? "enr";

  return {
    get enrollments() {
      return enrollments;
    },
    reset() {
      enrollments.clear();
      sequence.next = 1;
    },
    async issueEnrollment(input: TenantSecretBrokerIssueInput): Promise<TenantSecretBrokerIssueResult> {
      const enrollId = `${idPrefix}_${sequence.next++}`;
      enrollments.set(enrollId, {
        enrollId,
        tenantId: input.tenantId,
        product: input.product,
        secretType: input.secretType,
        revoked: false,
      });
      return { enrollId, secretShownOnce: true };
    },
    async revokeEnrollment(enrollId: string): Promise<TenantSecretBrokerRevokeResult> {
      const row = enrollments.get(enrollId);
      if (!row || row.revoked) return "not_found";
      row.revoked = true;
      return "revoked";
    },
  };
}
