export const FORBIDDEN_PUBLIC_OUTPUT =
  /wallet|hotkey|raw trust|trust[-\s]?score|payout|reward[-\s]?estimate|farming|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)|private[-\s]?scoreability|scoreability/i;

export function sanitizePublicText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (FORBIDDEN_PUBLIC_OUTPUT.test(trimmed)) {
    return "Sensitive Gittensory context is only available in private surfaces.";
  }
  return trimmed;
}

export function assertNoForbiddenPublicText(value: string): void {
  if (FORBIDDEN_PUBLIC_OUTPUT.test(value)) {
    throw new Error("Public output must not include wallet, hotkey, trust score, payout, or farming language.");
  }
}
