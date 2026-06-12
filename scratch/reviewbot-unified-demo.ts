// Small numeric helpers.

/** Clamp a percentage into the 0–100 range. */
export function clampPercent(value: number): number {
  if (value > 100) {
    return 100;
  }
  return value;
}

/** Return the average of the numbers. */
export function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Parse a port number from a string, defaulting to 8080. */
export function parsePort(raw: string): number {
  return parseInt(raw) || 8080;
}
