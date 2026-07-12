// Optional footer link to an operator's ORB/Grafana dashboard (#5194). Rendered only when the operator sets
// VITE_MINER_UI_GRAFANA_URL (Vite exposes only VITE_-prefixed vars to the client bundle; a bare name would be
// undefined at build time). The URL is a plain navigational link — no auth/session token or credential is ever
// appended, and it is rendered as a normal href attribute (React escapes it, so a misconfigured value cannot
// inject markup). Renders nothing when the var is unset or empty.
export function GrafanaFooterLink() {
  const url = import.meta.env.VITE_MINER_UI_GRAFANA_URL;
  // Own the whole <footer> wrapper and return null for ALL of it when unset — otherwise a wrapper rendered by
  // the layout would leave an empty, padded footer visible even though there is no link to show.
  if (!url) return null;
  return (
    <footer className="mx-auto max-w-5xl px-6 py-4 text-token-sm text-muted-foreground">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
      >
        ORB / Grafana dashboard ↗
      </a>
    </footer>
  );
}
