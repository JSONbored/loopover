const target = matchGitHubPageTarget(location.pathname);

if (target?.kind === "pull_request") {
  mountOverlay(target);
}

function matchGitHubPageTarget(pathname) {
  const match = String(pathname ?? "").match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo, surface, number] = match;
  if (surface === "pull") return { kind: "pull_request", owner, repo, pullNumber: Number(number) };
  return { kind: "issue", owner, repo, issueNumber: Number(number) };
}

function matchPullRequestTarget(pathname) {
  const target = matchGitHubPageTarget(pathname);
  if (target?.kind !== "pull_request") return null;
  return { owner: target.owner, repo: target.repo, pullNumber: target.pullNumber };
}

function mountOverlay(target) {
  if (document.querySelector("[data-gittensory-pr-context]")) return;
  const container = document.createElement("aside");
  const host = findPullRequestSidebar();
  container.className = `gittensory-overlay ${host ? "gittensory-overlay--sidebar" : "gittensory-overlay--floating"}`;
  container.dataset.gittensoryPrContext = "true";
  container.innerHTML = `
    <div class="gittensory-overlay__header">
      <span class="gittensory-overlay__mark">G</span>
      <span>LoopOver</span>
      <span class="gittensory-overlay__privacy">Private</span>
      <button type="button" class="gittensory-overlay__refresh" aria-label="Refresh LoopOver context">Refresh</button>
    </div>
    <div class="gittensory-overlay__body">Loading private context...</div>
  `;
  if (host) {
    host.prepend(container);
  } else {
    document.body.appendChild(container);
  }
  const refresh = container.querySelector(".gittensory-overlay__refresh");
  refresh?.addEventListener("click", () => load(container, target));
  void load(container, target);
}

function findPullRequestSidebar() {
  return (
    document.querySelector("#partial-discussion-sidebar") ||
    document.querySelector("[data-testid='pr-sidebar']") ||
    document.querySelector(".Layout-sidebar") ||
    document.querySelector(".discussion-sidebar")
  );
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
  body.innerHTML = renderPullContext(response.payload);
  renderActions(body, response.payload?.actions);
}

function renderPullContext(payload) {
  const sections = Array.isArray(payload?.sections) ? payload.sections : [];
  if (sections.length > 0) {
    return sections.map(renderSection).join("");
  }
  return renderLegacyPanels(payload);
}

function renderSection(section) {
  const rows = Array.isArray(section?.rows) ? section.rows : [];
  const items = Array.isArray(section?.items) ? section.items : [];
  const actions = Array.isArray(section?.actions) ? section.actions : [];
  const tone = ["good", "warn", "neutral", "private"].includes(section?.tone) ? section.tone : "neutral";
  return `
    <section class="gittensory-overlay__panel gittensory-overlay__panel--${tone}">
      <div class="gittensory-overlay__panel-head">
        <strong>${escapeHtml(section?.label || "Panel")}</strong>
        <span>${escapeHtml(section?.badge || "live")}</span>
      </div>
      ${rows.length > 0 ? `<dl>${rows.map((row) => `<div><dt>${escapeHtml(row.label || "")}</dt><dd>${escapeHtml(row.value || "")}</dd></div>`).join("")}</dl>` : ""}
      ${items.length > 0 ? `<ul class="gittensory-overlay__list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      ${actions.length > 0 ? `<ol class="gittensory-overlay__actions">${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol>` : ""}
    </section>
  `;
}

function renderLegacyPanels(payload) {
  const panels = Array.isArray(payload?.panels) ? payload.panels : [];
  if (panels.length === 0) return `<div class="gittensory-overlay__empty">No cached private context is available for this pull request.</div>`;
  return panels
    .map(
      (panel) => `
        <section class="gittensory-overlay__panel gittensory-overlay__panel--neutral">
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

function renderActions(body, actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return;
  const container = document.createElement("section");
  container.className = "gittensory-overlay__panel gittensory-overlay__panel--private";
  container.innerHTML = `
    <div class="gittensory-overlay__panel-head">
      <strong>Actions</strong>
      <span>extension</span>
    </div>
    <div class="gittensory-overlay__action-buttons"></div>
  `;
  const actionsNode = container.querySelector(".gittensory-overlay__action-buttons");
  if (!actionsNode) return;
  for (const action of list) {
    if (action?.id === "copy_public_safe_packet" && typeof action?.markdown === "string") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Copy public-safe packet";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(action.markdown);
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = "Copy public-safe packet";
          }, 1400);
        } catch {
          button.textContent = "Copy failed";
        }
      });
      actionsNode.appendChild(button);
      continue;
    }
    if (action?.id === "view_private_blockers" && Array.isArray(action?.blockers)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Private blockers";
      details.appendChild(summary);
      const listNode = document.createElement("ul");
      for (const blocker of action.blockers.slice(0, 8)) {
        const item = document.createElement("li");
        item.textContent = String(blocker?.detail ?? "");
        listNode.appendChild(item);
      }
      details.appendChild(listNode);
      actionsNode.appendChild(details);
    }
  }
  body.appendChild(container);
}

if (globalThis.__GITTENSORY_EXTENSION_TEST__) {
  globalThis.__gittensoryContentInternals = {
    matchGitHubPageTarget,
    matchPullRequestTarget,
    renderPullContext,
    renderSection,
    renderLegacyPanels,
    renderActions,
    escapeHtml,
  };
}
