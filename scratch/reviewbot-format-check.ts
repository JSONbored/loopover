// Throwaway fixture to confirm reviewbot posts the restored EXPANDED review format. Safe to delete.

/** Round a number to N decimal places. */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
