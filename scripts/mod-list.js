// Turns the overlay's "shuaqii <version>" title line into a button that opens a
// modal listing every script registered in scripts/core.js's registry
// (window.__sqScripts). Each row has an enable/disable checkbox; plugins add
// their own row buttons with __sqScripts.addAction(id, { label, title, onClick }).
// Requires scripts/core.js to be injected first.
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/mod-list.js
//
// The dialog is modal (dimmed backdrop, centred panel) and is rebuilt on every
// open; Esc, a backdrop click, or the x button close it. core.js owns the version
// line but not this UI, so this file binds the click itself and installs a small
// <style> that overrides core's inline `pointer-events: none` with !important, so
// the line stays clickable even if core.js is re-injected on its own. This script
// registers itself as locked, so it can never be disabled from its own list.

(async () => {
  const sq = window.__sq;
  const reg = window.__sqScripts;
  if (!sq || !reg) {
    console.warn("[mod-list] scripts/core.js must be injected first");
    return;
  }

  window.__sqModList?.dispose?.();
  await sq.ready;

  const ID = "mod-list";
  const TITLE_ID = "sq-overlay-version";
  const STYLE_ID = "sq-modlist-style";
  const FONT = "14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  let active = false;
  let dialog = null;
  let rowsHost = null;
  let unsubscribeChange = null;
  let showRequired = false; // locked (always-on) scripts are hidden until this is checked

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      #${TITLE_ID} {
        pointer-events: auto !important;
        cursor: pointer !important;
      }
      #${TITLE_ID}:hover { filter: brightness(1.4); }

      #sq-modlist-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.5);
        font: ${FONT};
        pointer-events: auto;
      }
      #sq-modlist-panel {
        min-width: 300px;
        max-width: 70vw;
        max-height: 70vh;
        overflow: auto;
        background: rgba(17, 17, 17, 0.97);
        color: #e5e5e5;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
        padding: 12px 14px;
        outline: none;
      }
      #sq-modlist-panel .ml-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
        color: #4ade80;
      }
      #sq-modlist-panel .ml-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      #sq-modlist-panel .ml-close:hover { color: #f87171; }
      #sq-modlist-panel .ml-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
      }
      #sq-modlist-panel .ml-row:first-child { border-top: 0; }
      #sq-modlist-panel .ml-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      #sq-modlist-panel .ml-title {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }
      #sq-modlist-panel .ml-label {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #sq-modlist-panel .ml-version {
        flex: none;
        font-size: 0.8em;
        color: #9ca3af;
      }
      #sq-modlist-panel .ml-desc {
        font-size: 12px;
        line-height: 1.3;
        opacity: 0.6;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #sq-modlist-panel .ml-row.ml-off .ml-info { opacity: 0.5; }
      #sq-modlist-panel .ml-locked { cursor: not-allowed; }
      #sq-modlist-panel .ml-filter {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0 8px;
        color: #9ca3af;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      #sq-modlist-panel .ml-filter input { margin: 0; cursor: pointer; }
      #sq-modlist-panel .ml-actions { display: flex; gap: 6px; }
      #sq-modlist-panel .ml-action {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 1px 6px;
      }
      #sq-modlist-panel .ml-action:hover { background: rgba(255, 255, 255, 0.16); }
    `;
  }

  function close() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    rowsHost = null;
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function makeRow(entry) {
    const row = document.createElement("div");
    row.className = "ml-row" + (entry.enabled ? "" : " ml-off");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.enabled;
    box.disabled = entry.locked;
    if (entry.locked) box.className = "ml-locked";
    box.title = entry.locked
      ? "always on"
      : entry.enabled
        ? "click to disable"
        : "click to enable";
    box.addEventListener("change", () => reg.setEnabled(entry.id, box.checked));
    row.appendChild(box);

    const info = document.createElement("div");
    info.className = "ml-info";

    const titleRow = document.createElement("div");
    titleRow.className = "ml-title";

    const label = document.createElement("span");
    label.className = "ml-label";
    label.textContent = entry.label;
    label.title = entry.id;
    titleRow.appendChild(label);

    if (entry.version) {
      const version = document.createElement("span");
      version.className = "ml-version";
      version.textContent = "v" + entry.version;
      version.title = "version " + entry.version;
      titleRow.appendChild(version);
    }
    info.appendChild(titleRow);

    if (entry.desc) {
      const desc = document.createElement("span");
      desc.className = "ml-desc";
      desc.textContent = entry.desc;
      desc.title = entry.desc;
      info.appendChild(desc);
    }
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "ml-actions";
    for (const action of entry.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ml-action";
      btn.textContent = action.label;
      if (action.title) btn.title = action.title;
      if (action.color) btn.style.color = action.color;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          action.onClick?.();
        } catch (err) {
          console.warn("[mod-list] action failed:", entry.id, err);
        }
      });
      actions.appendChild(btn);
    }
    row.appendChild(actions);
    return row;
  }

  function renderRows() {
    if (!rowsHost) return;
    const entries = reg.list().filter((entry) => showRequired || !entry.locked);
    rowsHost.replaceChildren(...entries.map(makeRow));
  }

  function open() {
    if (!active || dialog) return;

    const backdrop = document.createElement("div");
    backdrop.id = "sq-modlist-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    const panel = document.createElement("div");
    panel.id = "sq-modlist-panel";
    panel.tabIndex = -1;
    panel.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "ml-head";
    const title = document.createElement("span");
    title.textContent = `Scripts`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ml-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });
    head.append(title, closeBtn);
    panel.appendChild(head);

    const filter = document.createElement("label");
    filter.className = "ml-filter";
    filter.title = "also list the always-on (required) scripts";
    const filterBox = document.createElement("input");
    filterBox.type = "checkbox";
    filterBox.checked = showRequired;
    filterBox.addEventListener("change", () => {
      showRequired = filterBox.checked;
      renderRows();
    });
    const filterText = document.createElement("span");
    filterText.textContent = "Show required scripts";
    filter.append(filterBox, filterText);
    panel.appendChild(filter);

    rowsHost = document.createElement("div");
    panel.appendChild(rowsHost);
    renderRows();

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    document.addEventListener("keydown", onKey, true);
    panel.focus();
    dialog = backdrop;
  }

  function toggle() {
    if (dialog) close();
    else open();
  }

  function onTitleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }

  function bindTitle() {
    document.getElementById(TITLE_ID)?.addEventListener("click", onTitleClick);
  }

  function unbindTitle() {
    document.getElementById(TITLE_ID)?.removeEventListener("click", onTitleClick);
  }

  // core.js shows a styled hover tooltip for any element with data-sq-tip; the
  // "shuaqii <version>" line is already pointer-events:auto via the style above.
  function applyTitleTip() {
    const el = document.getElementById(TITLE_ID);
    if (el) el.dataset.sqTip = "click to open the mod list";
  }

  function clearTitleTip() {
    const el = document.getElementById(TITLE_ID);
    if (el) delete el.dataset.sqTip;
  }

  function mount() {
    active = true;
    ensureStyle();
    bindTitle();
    applyTitleTip();
    unsubscribeChange = reg.onChange(() => {
      if (dialog) renderRows();
    });
  }

  function unmount() {
    active = false;
    close();
    if (unsubscribeChange) {
      unsubscribeChange();
      unsubscribeChange = null;
    }
    unbindTitle();
    clearTitleTip();
    document.getElementById(STYLE_ID)?.remove();
  }

  window.__sqModList = { dispose: unmount, open, close, toggle, list: () => reg.list() };
  reg.register(ID, {
    label: "Mod List",
    version: "0.0.1",
    desc: "This dialog: view all your scripts.",
    locked: true,
    mount,
    unmount,
  });

  console.log("[mod-list] ready");
})();
