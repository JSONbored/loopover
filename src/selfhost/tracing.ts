// Shared review-pipeline span wrapper (#1734). Opens ONE OpenTelemetry boundary; Sentry receives the same span via
// the SentrySpanProcessor bridge when configured, avoiding duplicate direct Sentry spans.
import { withOtelSpan } from "./otel";

export async function withReviewSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: { parentTraceParent?: string | undefined },
): Promise<T> {
  return withOtelSpan(name, attributes, fn, options);
}
