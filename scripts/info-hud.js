// Bottom-right HUD showing handy facts about the current session: its id, slug and
// title, working directory, project id and app version, the current agent/model,
// token usage and cost, changed-file stats, age / last activity, and message count.
// Requires scripts/core.js to be injected first (window.__sq shared services and the
// window.__sqScripts registry it registers itself with).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/info-hud.js
//
// It renders one overlay item built from a two-column grid (label + value) instead
// of several stacked lines, so it stays compact. The session id comes from the app's
// routing state (__sq.currentSessionId) and the message count from the session's
// message list (__sq.messages); everything else comes from GET /session/{id}, fetched
// once per poll with a short cache.
//
// Its row in the mod list carries a "Settings" button opening a dialog where each
// field can be shown or hidden; the choice is applied live and persisted to
// localStorage["shuaqii.info-hud"].

(async () => {
  const sq = window.__sq;
  const overlay = window.__sqOverlay;
  const reg = window.__sqScripts;
  if (!sq || !overlay || !reg) {
    console.warn("[info-hud] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "info-hud";
  const POLL_MS = 1000;
  const COLOR_VALUE = "#4ade80";
  const COLOR_MUTED = "#737373";
  const STORE_KEY = "shuaqii.info-hud";
  const SETTINGS_STYLE_ID = "sq-info-hud-style";
  const DIALOG_ID = "sq-infohud-backdrop";

  const ROWS = [
    { key: "session", label: "session", title: "current session id" },
    { key: "slug", label: "slug", title: "human-friendly session slug" },
    { key: "title", label: "title", title: "session title" },
    { key: "directory", label: "directory", title: "session working directory" },
    { key: "agent", label: "agent", title: "current agent" },
    { key: "model", label: "model", title: "current model" },
    { key: "tokens", label: "tokens", title: "token usage: input / output / reasoning / cache" },
    { key: "cost", label: "cost", title: "session cost in USD" },
    { key: "changes", label: "changes", title: "files changed this session: +added -deleted · files" },
    { key: "age", label: "age", title: "time since the session was created" },
    { key: "updated", label: "updated", title: "time since the last activity" },
    { key: "messages", label: "messages", title: "messages in the current session" },
    { key: "project", label: "project", title: "project id" },
    { key: "version", label: "version", title: "app version" },
    { key: "window", label: "window", title: "desktop window id" },
  ];

  const state = {};
  const metaCache = { id: null, at: 0, data: null };

  let active = false;
  let unsubscribe = null;
  let root = null;
  let cells = null; // key -> value span
  let labels = null; // key -> label span
  let lastSig = null;
  let dialog = null;

  // ---- settings -------------------------------------------------------------
  function defaultRows() {
    const out = {};
    for (const row of ROWS) out[row.key] = true;
    return out;
  }

  function readSettings() {
    const out = defaultRows();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const rows = parsed && typeof parsed === "object" ? parsed.rows : null;
      if (rows && typeof rows === "object") {
        for (const row of ROWS) {
          if (typeof rows[row.key] === "boolean") out[row.key] = rows[row.key];
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function writeSettings(rows) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ rows }));
    } catch {
      /* ignore */
    }
  }

  let settings = readSettings();

  // ---- data -----------------------------------------------------------------
  function fmtModel(model) {
    if (!model) return null;
    if (typeof model === "string") return model;
    const provider = model.providerID || model.provider;
    const id = model.modelID || model.id || model.model;
    if (provider && id) return `${provider}/${id}`;
    return id || provider || null;
  }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function fmtTokens(t) {
    if (!t || typeof t !== "object") return null;
    const cache = t.cache || {};
    const parts = [`in ${fmtCount(t.input)}`, `out ${fmtCount(t.output)}`];
    if (t.reasoning) parts.push(`think ${fmtCount(t.reasoning)}`);
    const cached = (cache.read || 0) + (cache.write || 0);
    if (cached) parts.push(`cache ${fmtCount(cached)}`);
    return parts.join(" \u00b7 ");
  }

  function fmtCost(c) {
    if (typeof c !== "number") return null;
    return "$" + (c > 0 && c < 1 ? c.toFixed(4) : c.toFixed(2));
  }

  // Coarse durations so the value only changes on the minute: keeps the polled
  // signature stable instead of rewriting the DOM every second.
  function fmtDuration(ms) {
    if (ms == null || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function fmtAgo(ms) {
    if (ms == null || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // GET /session/{id}, short-cached so a 1s poll is one request per session.
  async function sessionMeta(id, maxAge) {
    if (!sq.server || !sq.auth || !id) return null;
    if (metaCache.id === id && metaCache.data && Date.now() - metaCache.at < maxAge) {
      return metaCache.data;
    }
    try {
      const res = await fetch(`${sq.server.url}/session/${encodeURIComponent(id)}`, {
        headers: { Authorization: sq.auth },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== "object") return null;
      metaCache.id = id;
      metaCache.at = Date.now();
      metaCache.data = data;
      return data;
    } catch {
      return null;
    }
  }

  async function refresh() {
    const id = sq.currentSessionId();
    state.session = id;
    state.window = sq.windowID == null ? null : String(sq.windowID);

    if (!id) {
      for (const row of ROWS) {
        if (row.key !== "window") state[row.key] = null;
      }
      return;
    }

    const [list, meta] = await Promise.all([
      sq.messages(id, POLL_MS),
      sessionMeta(id, POLL_MS),
    ]);
    if (id !== sq.currentSessionId()) return; // session switched while loading

    const info = Array.isArray(list) ? sq.lastUserInfo(list) : null;
    const model = (meta && meta.model) || (info && info.model);
    const agent = (meta && meta.agent) || (info && info.agent);

    state.title = (meta && meta.title) || null;
    state.directory = (meta && meta.directory) || null;
    state.model = fmtModel(model);
    state.agent = agent || null;
    state.tokens = meta ? fmtTokens(meta.tokens) : null;
    state.cost = meta ? fmtCost(meta.cost) : null;
    state.messages = Array.isArray(list) ? list.length : null;

    state.slug = (meta && meta.slug) || null;
    state.project = (meta && meta.projectID) || null;
    state.version = (meta && meta.version) || null;
    const time = (meta && meta.time) || {};
    const now = Date.now();
    state.age = time.created ? fmtDuration(now - time.created) : null;
    state.updated = time.updated ? fmtAgo(now - time.updated) : null;
    const sum = meta && meta.summary;
    state.changes = sum
      ? `+${sum.additions || 0} -${sum.deletions || 0} \u00b7 ${sum.files || 0} file${sum.files === 1 ? "" : "s"}`
      : null;
  }

  // ---- UI -------------------------------------------------------------------
  // Build the grid once; later ticks only rewrite the value spans.
  function buildUI() {
    root = document.createElement("div");
    Object.assign(root.style, {
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr)",
      columnGap: "10px",
      rowGap: "2px",
      maxWidth: "60vw",
      pointerEvents: "none",
    });

    cells = {};
    labels = {};
    for (const row of ROWS) {
      const label = document.createElement("span");
      label.textContent = row.label;
      label.title = row.title;
      label.style.color = COLOR_MUTED;

      const value = document.createElement("span");
      value.textContent = "\u2014";
      value.style.color = COLOR_VALUE;
      value.style.overflow = "hidden";
      value.style.textOverflow = "ellipsis";
      value.style.whiteSpace = "nowrap";
      value.style.userSelect = "text";

      root.append(label, value);
      labels[row.key] = label;
      cells[row.key] = value;
    }

    applyVisibility();
    overlay.setNode(ID, root, { interactive: false });
  }

  // Show/hide whole rows from the persisted settings.
  function applyVisibility() {
    if (!root || !labels || !cells) return;
    let any = false;
    for (const row of ROWS) {
      const on = settings[row.key] !== false;
      const display = on ? "" : "none";
      if (labels[row.key].style.display !== display) labels[row.key].style.display = display;
      if (cells[row.key].style.display !== display) cells[row.key].style.display = display;
      if (on) any = true;
    }
    root.style.display = any ? "grid" : "none";
  }

  function render() {
    if (!active || !root || !cells) return;
    applyVisibility();
    let sig = "";
    for (const row of ROWS) {
      const value = state[row.key];
      sig += `${row.key}=${value == null ? "" : value}\u0000`;
    }
    if (sig === lastSig) return; // nothing changed: no DOM write
    lastSig = sig;

    for (const row of ROWS) {
      const value = state[row.key];
      const span = cells[row.key];
      const empty = value == null || value === "";
      const text = empty ? "\u2014" : String(value);
      if (span.textContent !== text) span.textContent = text;
      span.style.color = empty ? COLOR_MUTED : COLOR_VALUE;
      span.title = empty ? "" : String(value);
    }
  }

  // ---- settings dialog ------------------------------------------------------
  function ensureSettingsStyle() {
    let style = document.getElementById(SETTINGS_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = SETTINGS_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      #${DIALOG_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.5);
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        pointer-events: auto;
      }
      #${DIALOG_ID} .ih-panel {
        min-width: 260px;
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
      #${DIALOG_ID} .ih-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        color: #4ade80;
      }
      #${DIALOG_ID} .ih-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      #${DIALOG_ID} .ih-close:hover { color: #f87171; }
      #${DIALOG_ID} .ih-rows { display: flex; flex-direction: column; gap: 6px; }
      #${DIALOG_ID} .ih-row {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      #${DIALOG_ID} .ih-row input { margin: 0; cursor: pointer; }
      #${DIALOG_ID} .ih-hint { margin-top: 4px; color: #737373; }
      #${DIALOG_ID} .ih-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
      #${DIALOG_ID} .ih-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 10px;
      }
      #${DIALOG_ID} .ih-btn:hover { background: rgba(255, 255, 255, 0.16); }
    `;
  }

  function closeSettings() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    window.removeEventListener("keydown", onDialogKey, true);
    document.getElementById(SETTINGS_STYLE_ID)?.remove();
  }

  // Capture on window (not document) so Escape closes only this dialog and not the
  // mod list modal underneath it.
  function onDialogKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSettings();
    }
  }

  function button(label, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    return b;
  }

  function openSettings() {
    if (dialog) return;
    ensureSettingsStyle();

    const backdrop = document.createElement("div");
    backdrop.id = DIALOG_ID;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeSettings();
    });

    const panel = document.createElement("div");
    panel.className = "ih-panel";
    panel.tabIndex = -1;
    panel.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "ih-head";
    const title = document.createElement("span");
    title.textContent = "Info HUD \u00b7 Settings";
    const closeBtn = button("\u00d7", "ih-close");
    closeBtn.title = "close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSettings();
    });
    head.append(title, closeBtn);
    panel.appendChild(head);

    const rowsBox = document.createElement("div");
    rowsBox.className = "ih-rows";
    const boxes = {};
    for (const row of ROWS) {
      const label = document.createElement("label");
      label.className = "ih-row";
      label.title = row.title;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = settings[row.key] !== false;
      box.addEventListener("change", () => {
        settings[row.key] = box.checked;
        writeSettings(settings);
        render();
      });
      const text = document.createElement("span");
      text.textContent = row.label;
      label.append(box, text);
      rowsBox.appendChild(label);
      boxes[row.key] = box;
    }
    panel.appendChild(rowsBox);

    const hint = document.createElement("div");
    hint.className = "ih-hint";
    hint.textContent = "Unchecked fields are hidden from the HUD.";
    panel.appendChild(hint);

    const actions = document.createElement("div");
    actions.className = "ih-actions";
    const reset = button("Show all", "ih-btn");
    reset.addEventListener("click", () => {
      settings = defaultRows();
      writeSettings(settings);
      for (const row of ROWS) boxes[row.key].checked = true;
      render();
    });
    const done = button("Close", "ih-btn");
    done.addEventListener("click", closeSettings);
    actions.append(reset, done);
    panel.appendChild(actions);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    window.addEventListener("keydown", onDialogKey, true);
    panel.focus();
    dialog = backdrop;
  }

  // ---- lifecycle ------------------------------------------------------------
  async function tick() {
    if (!active) return;
    await refresh();
    render();
  }

  function mount() {
    active = true;
    for (const row of ROWS) state[row.key] = null;
    metaCache.id = null;
    metaCache.at = 0;
    metaCache.data = null;
    settings = readSettings();
    lastSig = null;
    buildUI();
    unsubscribe = sq.every(POLL_MS, tick);
    tick().catch(() => {});
  }

  function unmount() {
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    closeSettings();
    overlay.remove(ID);
    root = null;
    cells = null;
    labels = null;
  }

  window.__sqInfoHud = {
    dispose: unmount,
    refresh,
    render,
    applyVisibility,
    fmtModel,
    fmtTokens,
    fmtCost,
    fmtDuration,
    fmtAgo,
    sessionMeta,
    openSettings,
    closeSettings,
    get state() {
      return { ...state };
    },
    get settings() {
      return { ...settings };
    },
  };
  reg.register(ID, {
    label: "Info HUD",
    version: "0.0.1",
    desc: "Session id, agent/model, tokens, cost and more.",
    enabled: false,
    actions: [{ label: "Settings", title: "Info HUD settings", onClick: openSettings }],
    mount,
    unmount,
  });

  console.log("[info-hud] registered");
})();
