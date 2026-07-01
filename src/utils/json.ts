export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(error: unknown, fallback = "unknown error"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function strippedErrorMessage(error: unknown, fallback: string): string {
  const message = errorMessage(error, "");
  return message.replace(/^Error: /, "") || fallback;
}

export function normalizeRepoFullName(value: string): string {
  return value.trim();
}

export function repoParts(fullName: string): { owner: string; name: string } {
  const normalized = fullName.trim();
  if (normalized.length === 0) return { owner: "", name: "" };
  const [owner, ...rest] = normalized.split("/") as [string, ...string[]];
  return {
    owner,
    name: rest.join("/"),
  };
}

export function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
