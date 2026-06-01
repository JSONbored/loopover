const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

if (match) {
  const [, owner, repo, pullNumber] = match;
  mountOverlay({ owner, repo, pullNumber: Number(pullNumber) });
}

function mountOverlay(target) {
  const container = document.createElement("aside");
  container.className = "gittensory-overlay";
  container.innerHTML = `
    <div class="gittensory-overlay__header">
      <span class="gittensory-overlay__mark">G</span>
      <span>Gittensory</span>
      <button type="button" class="gittensory-overlay__refresh" aria-label="Refresh Gittensory context">Refresh</button>
    </div>
    <div class="gittensory-overlay__body">Loading private context...</div>
  `;
  document.body.appendChild(container);
  const refresh = container.querySelector(".gittensory-overlay__refresh");
  refresh?.addEventListener("click", () => load(container, target));
  void load(container, target);
}

async function load(container, target) {
  const body = container.querySelector(".gittensory-overlay__body");
  if (!body) return;
  body.textContent = "Loading private context...";
  const response = await chrome.runtime.sendMessage({ type: "gittensory:pull-context", ...target });
  if (!response?.ok) {
    body.innerHTML = `<div class="gittensory-overlay__error">${escapeHtml(response?.error || "Context unavailable")}</div>`;
    return;
  }
  const panels = Array.isArray(response.payload?.panels) ? response.payload.panels : [];
  body.innerHTML = panels
    .map(
      (panel) => `
        <section class="gittensory-overlay__panel">
          <div class="gittensory-overlay__panel-head">
            <strong>${escapeHtml(panel.label || "Panel")}</strong>
            <span>${escapeHtml(panel.badge || "live")}</span>
          </div>
          <dl>
            ${(Array.isArray(panel.rows) ? panel.rows : [])
              .map((row) => `<div><dt>${escapeHtml(row.k || "")}</dt><dd>${escapeHtml(row.v || "")}</dd></div>`)
              .join("")}
          </dl>
        </section>
      `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
