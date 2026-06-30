// Shared review-pipeline span wrapper (#1734). Opens ONE boundary that feeds BOTH tracers — an OpenTelemetry span
// and a Sentry span — so a stage is instrumented once and shows up in whichever backend is enabled. Kept in this
// neutral module (rather than inside otel.ts or sentry.ts) so a caller wires the normal review boundary without
// importing from, or coupling to, either tracer's module. Each side independently no-ops when its backend is off,
// so this reduces to `fn()` when neither is configured.
import { withOtelSpan } from "./otel";
import { withSentrySpan } from "./sentry";

export async function withReviewSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: { parentTraceParent?: string | undefined },
): Promise<T> {
  return withOtelSpan(name, attributes, () => withSentrySpan(name, attributes, fn), options);
}
