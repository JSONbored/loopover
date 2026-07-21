// Tests for the #7667 PagerDuty mirror: the pure alert builder, and the Events API v2 enqueue call's every
// guard branch (flag off, missing key, malformed key, success, non-ok response, thrown fetch error). No live
// network call is ever made -- `globalThis.fetch` is stubbed for every notify test.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { buildProvisioningPagerDutyAlert, notifyProvisioningFailure } from "../dist/index.js";

const VALID_ROUTING_KEY = "a".repeat(32);

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

test("buildProvisioningPagerDutyAlert: provision failure builds a critical alert from an Error (#7667)", () => {
  const alert = buildProvisioningPagerDutyAlert({
    tenantName: "acme",
    product: "orb",
    phase: "provision",
    error: new Error("container quota exceeded"),
  });

  assert.deepEqual(alert, {
    tenantName: "acme",
    product: "orb",
    phase: "provision",
    summary: "orb tenant provision failed for acme: container quota exceeded",
    severity: "critical",
    dedupKey: "control_plane_provision_failed:orb:acme",
    customDetails: {
      tenantName: "acme",
      product: "orb",
      phase: "provision",
      message: "container quota exceeded",
    },
  });
});

test("buildProvisioningPagerDutyAlert: deprovision failure coerces a non-Error thrown value (#7667)", () => {
  const alert = buildProvisioningPagerDutyAlert({
    tenantName: "acme",
    product: "ams",
    phase: "deprovision",
    error: "connection refused",
  });

  assert.equal(alert.phase, "deprovision");
  assert.equal(alert.dedupKey, "control_plane_deprovision_failed:ams:acme");
  assert.match(alert.summary, /connection refused/);
  assert.equal(alert.customDetails.message, "connection refused");
});

test("notifyProvisioningFailure: no-op when LOOPOVER_ENABLE_PAGERDUTY is not truthy (#7667)", async () => {
  const fetchMock = mock.fn(async () => new Response(null, { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await notifyProvisioningFailure(alert, {});

  assert.equal(fetchMock.mock.calls.length, 0);
});

test("notifyProvisioningFailure: no-op when the flag is on but no routing key resolves (#7667)", async () => {
  const fetchMock = mock.fn(async () => new Response(null, { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await notifyProvisioningFailure(alert, { LOOPOVER_ENABLE_PAGERDUTY: "true" });

  assert.equal(fetchMock.mock.calls.length, 0);
});

test("notifyProvisioningFailure: no-op when the routing key is present but malformed (#7667)", async () => {
  const fetchMock = mock.fn(async () => new Response(null, { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await notifyProvisioningFailure(alert, { LOOPOVER_ENABLE_PAGERDUTY: "1", PAGERDUTY_ROUTING_KEY: "not-hex" });

  assert.equal(fetchMock.mock.calls.length, 0);
});

test("notifyProvisioningFailure: fires the Events API v2 enqueue call when enabled and configured (#7667)", async () => {
  const fetchMock = mock.fn(async () => new Response(null, { status: 202 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await notifyProvisioningFailure(alert, { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY });

  assert.equal(fetchMock.mock.calls.length, 1);
  const call = fetchMock.mock.calls[0];
  const [url, init] = call?.arguments ?? [];
  assert.equal(url, "https://events.pagerduty.com/v2/enqueue");
  const body = JSON.parse((init as RequestInit).body as string) as {
    routing_key: string;
    event_action: string;
    dedup_key: string;
    payload: { severity: string; component: string; source: string };
  };
  assert.equal(body.routing_key, VALID_ROUTING_KEY);
  assert.equal(body.event_action, "trigger");
  assert.equal(body.dedup_key, alert.dedupKey);
  assert.equal(body.payload.severity, "critical");
  assert.equal(body.payload.component, "acme");
  assert.equal(body.payload.source, "loopover-control-plane");
});

test("notifyProvisioningFailure: a non-ok response is warned but never throws (#7667)", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
  const warnMock = mock.method(console, "warn", () => {});
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await notifyProvisioningFailure(alert, { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY });

  assert.equal(warnMock.mock.calls.length, 1);
});

test("notifyProvisioningFailure: a thrown fetch error is caught and warned, never throws (#7667)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const warnMock = mock.method(console, "warn", () => {});
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  await assert.doesNotReject(
    notifyProvisioningFailure(alert, { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY }),
  );

  assert.equal(warnMock.mock.calls.length, 1);
});

test("notifyProvisioningFailure: falls back to process.env when no env override is passed (#7667)", async () => {
  const hadFlag = Object.prototype.hasOwnProperty.call(process.env, "LOOPOVER_ENABLE_PAGERDUTY");
  const previousFlag = process.env.LOOPOVER_ENABLE_PAGERDUTY;
  delete process.env.LOOPOVER_ENABLE_PAGERDUTY;
  const fetchMock = mock.fn(async () => new Response(null, { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const alert = buildProvisioningPagerDutyAlert({ tenantName: "acme", product: "orb", phase: "provision", error: new Error("boom") });

  try {
    await notifyProvisioningFailure(alert);
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    if (hadFlag) process.env.LOOPOVER_ENABLE_PAGERDUTY = previousFlag;
  }
});
