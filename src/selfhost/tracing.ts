// Shared review-pipeline span wrapper (#1734). Opens ONE OpenTelemetry boundary, exported over OTLP when
// configured (see ./otel's resolveOtelTraceEndpoint, including its PostHog-derived default).
import { withOtelSpan } from "./otel";

export async function withReviewSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: { parentTraceParent?: string | undefined },
): Promise<T> {
  return withOtelSpan(name, attributes, fn, options);
}
