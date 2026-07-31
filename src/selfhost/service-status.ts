// Public service status, sourced from the deployment's OWN alerting stack (#9983, slice of #9747).
//
// WHY ALERTMANAGER RATHER THAN A NEW PROBE. #9747 says to reuse the existing health/alerting
// instrumentation, and on the Orb that is Grafana-managed rules -> Alertmanager -> PagerDuty. A second,
// status-page-only probe would be a second opinion about the same components, free to disagree with the one
// that actually pages a human — and when they disagree, the public page is the one nobody is watching. Reading
// the alerting stack means the page says exactly what the on-call rotation already believes.
//
// NO NEW INFRASTRUCTURE. The app container already reaches Alertmanager on the compose network (verified:
// `fetch("http://alertmanager:9093/api/v2/alerts")` returns `[]` from inside the running container), and the
// existing Cloudflare Tunnel already routes `^/v1/public/.*$` to this app, so the route is publicly reachable
// the moment it ships — no tunnel edit and no new hostname, which matters because there is no `cert.pem` on
// the box to mint one with.
//
// UNREACHABLE IS `unknown`, NEVER `operational`. This is the whole correctness content of the module. A status
// page that renders green because it could not reach its source is worse than no status page: it actively
// tells people the thing is fine at exactly the moment nobody can confirm it. Same false-green class as a
// verifier that skips every claim and exits zero. So every failure path — unset URL, network error, timeout,
// non-200, unparseable body — lands on `unknown` with a stated reason, and `operational` is only ever reached
// by successfully reading the alert list and finding nothing firing for that component.
//
// PUBLIC-SAFE BY CONSTRUCTION. The response carries component name, status, and a since-timestamp. It never
// carries a hostname, an instance id, a capacity figure, an alert annotation, or a label bag — alert payloads
// routinely contain internal host and job labels, so this maps them to a fixed component vocabulary and drops
// the original rather than filtering it. Whitelisting the shape is what keeps a new alert label from leaking
// through a filter nobody updated.

/** The components this deployment reports on. A FIXED vocabulary, not whatever labels the alerts happen to
 *  carry: the mapping is what turns internal topology into a public name, and an unmapped alert must widen
 *  this list deliberately rather than publish a label verbatim. */
export const SERVICE_STATUS_COMPONENTS = ["review", "testing", "discovery"] as const;
export type ServiceComponent = (typeof SERVICE_STATUS_COMPONENTS)[number];

/** Human-facing names, so the public surface never shows an internal identifier. */
const SERVICE_COMPONENT_LABELS: Record<ServiceComponent, string> = {
  review: "ORB review service",
  testing: "AMS testing service",
  discovery: "Discovery index",
};

/**
 * Which alert `service` label belongs to which public component.
 *
 * Read from the alert's `service` label only. Alertmanager alerts also carry `job`, `instance`, `pod` and
 * similar, all of which name infrastructure; binding to one deliberate label keeps the public mapping
 * explicit and keeps host identifiers out of the decision entirely.
 */
const SERVICE_LABEL_TO_COMPONENT: Record<string, ServiceComponent> = {
  loopover: "review",
  orb: "review",
  review: "review",
  ams: "testing",
  testing: "testing",
  "discovery-index": "discovery",
  discovery: "discovery",
};

/** `operational` — read the source, nothing firing. `degraded` — a warning-severity alert is firing.
 *  `outage` — a critical one is. `unknown` — the source could not be read, which is never green. */
export type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";

export type ServiceComponentState = {
  component: ServiceComponent;
  label: string;
  status: ComponentStatus;
  /** When the current state began: the earliest firing alert's start for a non-operational component, else
   *  null. Null rather than "now" — inventing a timestamp would imply a transition that did not happen. */
  since: string | null;
  /** Present only when status is `unknown`, saying why the source could not be read. Never carries a URL or
   *  hostname: the reason is a category, not a connection string. */
  reason?: string;
};

export type ServiceStatusPayload = {
  generatedAt: string;
  /** The worst component status, so a caller can answer "is anything wrong" without walking the list. */
  overall: ComponentStatus;
  components: ServiceComponentState[];
};

/** One Alertmanager alert, narrowed to the two fields this reads. Structural, so a newer Alertmanager that
 *  adds fields still parses. */
export type AlertmanagerAlert = {
  labels?: Record<string, unknown> | undefined;
  startsAt?: unknown;
  status?: { state?: unknown } | undefined;
};

/** PURE. Severity ranking, so `overall` and per-component rollups agree on which state is worse. */
const SEVERITY_RANK: Record<ComponentStatus, number> = { operational: 0, unknown: 1, degraded: 2, outage: 3 };

/** PURE. The worse of two statuses. `unknown` outranks `operational` — a component we could not read must not
 *  be averaged away by one we could. */
export function worseStatus(a: ComponentStatus, b: ComponentStatus): ComponentStatus {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** PURE. An alert's severity mapped to a status. Anything that is not explicitly `critical` is treated as
 *  `degraded`: an unrecognised severity is still a firing alert, and rounding it DOWN to operational would
 *  hide it. */
export function statusForSeverity(severity: unknown): ComponentStatus {
  return typeof severity === "string" && severity.toLowerCase() === "critical" ? "outage" : "degraded";
}

/** PURE. Is this alert actually firing? Alertmanager returns suppressed alerts too when asked; a silenced or
 *  inhibited alert is deliberately not paging anyone, so it must not colour the public board either. */
export function isFiring(alert: AlertmanagerAlert): boolean {
  const state = alert.status?.state;
  return typeof state !== "string" || state === "active";
}

/**
 * PURE. Fold firing alerts into a per-component board.
 *
 * Every component in the vocabulary appears, whether or not it has alerts — a status page that omits a healthy
 * component is indistinguishable from one that forgot to check it. Alerts whose `service` label is unmapped
 * are IGNORED rather than published under a made-up component: publishing an unrecognised internal label is
 * exactly the leak this module's whitelist exists to prevent.
 */
export function buildServiceStatus(alerts: readonly AlertmanagerAlert[], generatedAt: string): ServiceStatusPayload {
  const states = new Map<ServiceComponent, { status: ComponentStatus; since: string | null }>();
  for (const component of SERVICE_STATUS_COMPONENTS) states.set(component, { status: "operational", since: null });

  for (const alert of alerts) {
    if (!isFiring(alert)) continue;
    const service = alert.labels?.["service"];
    const component = typeof service === "string" ? SERVICE_LABEL_TO_COMPONENT[service.toLowerCase()] : undefined;
    if (component === undefined) continue;
    const current = states.get(component)!;
    const status = worseStatus(current.status, statusForSeverity(alert.labels?.["severity"]));
    // Earliest start wins: the incident began when the FIRST alert for this component fired, not when the
    // most recent one did.
    const startsAt = typeof alert.startsAt === "string" ? alert.startsAt : null;
    const since = current.since === null ? startsAt : startsAt === null ? current.since : startsAt < current.since ? startsAt : current.since;
    states.set(component, { status, since });
  }

  const components = SERVICE_STATUS_COMPONENTS.map((component) => {
    const state = states.get(component)!;
    return {
      component,
      label: SERVICE_COMPONENT_LABELS[component],
      status: state.status,
      // `since` is only meaningful for a component that is currently in a non-operational state.
      since: state.status === "operational" ? null : state.since,
    };
  });

  return { generatedAt, overall: components.reduce<ComponentStatus>((worst, entry) => worseStatus(worst, entry.status), "operational"), components };
}

/** PURE. Every component `unknown`, for the paths where the source could not be read at all. */
export function unknownServiceStatus(generatedAt: string, reason: string): ServiceStatusPayload {
  return {
    generatedAt,
    overall: "unknown",
    components: SERVICE_STATUS_COMPONENTS.map((component) => ({
      component,
      label: SERVICE_COMPONENT_LABELS[component],
      status: "unknown" as const,
      since: null,
      reason,
    })),
  };
}

/** Is a status surface configured on this deployment? The hosted Worker has no Alertmanager, and a board that
 *  reads "unknown" for everything forever is not a status page — the route 404s there instead. */
export function isServiceStatusEnabled(env: { LOOPOVER_ALERTMANAGER_URL?: string | undefined }): boolean {
  return (env.LOOPOVER_ALERTMANAGER_URL ?? "").trim() !== "";
}

/** How long to wait on the alerting source. A status endpoint that hangs is itself an outage, and this route
 *  is unauthenticated and cacheable, so it must always answer. */
const ALERTMANAGER_TIMEOUT_MS = 4_000;

/**
 * Read the deployment's alerting source and build the public board.
 *
 * NEVER THROWS, and never degrades to `operational`. Every failure lands on {@link unknownServiceStatus} with
 * a category reason — the reason deliberately does not include the configured URL, which is internal topology.
 */
export async function loadServiceStatus(
  env: { LOOPOVER_ALERTMANAGER_URL?: string | undefined },
  options: { now?: Date | undefined; fetchImpl?: typeof fetch | undefined } = {},
): Promise<ServiceStatusPayload> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const base = (env.LOOPOVER_ALERTMANAGER_URL ?? "").trim();
  if (base === "") return unknownServiceStatus(generatedAt, "alerting source not configured");

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${base.replace(/\/+$/, "")}/api/v2/alerts`, { signal: AbortSignal.timeout(ALERTMANAGER_TIMEOUT_MS) });
  } catch {
    // Network error or timeout. Both mean the same thing publicly: we could not check.
    return unknownServiceStatus(generatedAt, "alerting source unreachable");
  }
  if (!response.ok) return unknownServiceStatus(generatedAt, "alerting source returned an error");

  let alerts: unknown;
  try {
    alerts = await response.json();
  } catch {
    return unknownServiceStatus(generatedAt, "alerting source returned an unreadable response");
  }
  // A non-array body is a source we do not understand, which is not the same as no alerts — treating it as
  // "nothing firing" would publish green off a payload we failed to parse.
  if (!Array.isArray(alerts)) return unknownServiceStatus(generatedAt, "alerting source returned an unexpected shape");

  return buildServiceStatus(alerts as AlertmanagerAlert[], generatedAt);
}
