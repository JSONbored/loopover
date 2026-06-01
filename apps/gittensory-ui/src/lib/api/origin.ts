const DEFAULT_API_ORIGIN = "https://gittensory-api.aethereal.dev";

export function getApiOrigin(): string {
  const configured = import.meta.env.VITE_GITTENSORY_API_ORIGIN?.trim();
  const origin = configured || DEFAULT_API_ORIGIN;
  return origin.replace(/\/+$/, "");
}
