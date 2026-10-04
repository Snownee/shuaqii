// Bottom-right checkbox: when checked, if the current session aborts abnormally
// (e.g. an assistant message that failed with "Bad Request: ..."), it sends a
// message with the text "continue". It keeps doing this until the session aborts
// abnormally 3 times in a row, then stops (and unchecks itself).
// Requires scripts/core.js to be injected first (window.__sq shared services and
// the window.__sqScripts registry it registers itself with).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/retry.js
//
// How it decides:
//   running  -> the session's own tail is unfinished: page-independent, via
//               __sq.sessionBusy (core.js), so it no longer depends on the composer
//               icon of whichever session page is on screen
//   abnormal -> the last assistant message has info.error (ignoring MessageAbortedError,
//               which is a manual stop), or its text contains "Bad Request"
//   success  -> the last assistant message completed with no error -> resets the counter
// Sending uses POST /session/{id}/prompt_async (returns 204, no streaming to drain).
//
// Its row in the mod list carries a "Settings" button opening a dialog where the
// message sent on retry is edited; it is applied live and persisted to
// localStorage["shuaqii.retry"]. The checkbox's armed state is persisted
// there too, so re-injection/restart re-arms it (disabled after an auto-stop).

(async () => {
  const sq = window.__sq;
  const overlay = window.__sqOverlay;
  const reg = window.__sqScripts;
  if (!sq || !overlay || !reg) {
    console.warn("[retry] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "retry";
  const POLL_MS = 1500;
  const MAX_CONSECUTIVE = 3;
  const COLOR_OK = "#4ade80";
  const COLOR_ERROR = "#f87171";
  const SETTINGS_STYLE_ID = "sq-retry-settings-style";
  const DIALOG_ID = "sq-retry-backdrop";
  const STORE_KEY = "shuaqii.retry";
  const DEFAULTS = { text: "continue", enabled: false };

  const state = {
    enabled: false,
    enabledAt: 0,
    sessionId: null,
    consecutive: 0,
    lastHandledErrorId: null,
    note: "",
  };

  let active = false;
  let unsubscribe = null;
  let wrap = null;
  let box = null;
  let text = null;
  let el = null;

  const isRunning = () => sq.isRunning();

  // classify the tail of a session's messages
  function classify(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const info = (list[i] && list[i].info) || {};
      if (info.role !== "assistant") continue;
      const created = (info.time && info.time.created) || 0;
      const err = info.error;
      if (!err) {
        const texts = ((list[i].parts || []) || []).filter((p) => p.type === "text").map((p) => p.text || "");
        const bad = texts.find((t) => /bad request/i.test(t));
        return bad
          ? { kind: "error", id: info.id, created, name: "BadRequest", message: bad.slice(0, 200) }
          : { kind: "ok" };
      }
      if (err.name === "MessageAbortedError") return { kind: "ok" };
      return {
        kind: "error",
        id: info.id,
        created,
        name: err.name,
        message: (err.data && err.data.message) || err.message || err.name,
      };
    }
    return { kind: "none" };
  }

  async function loadMessages(id) {
    return sq.messages(id, POLL_MS);
  }

  async function sendContinue(id, userInfo) {
    const body = { parts: [{ type: "text", text: settingsCache.text }] };
    if (userInfo) {
      if (userInfo.agent) body.agent = userInfo.agent;
      if (userInfo.model) body.model = userInfo.model;
    }
    const res = await fetch(`${sq.server.url}/session/${encodeURIComponent(id)}/prompt_async`, {
      method: "POST",
      headers: { Authorization: sq.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  }

  // ---- settings -------------------------------------------------------------
  function readSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
      return {
        text:
          typeof parsed.text === "string" && parsed.text.trim() !== ""
            ? parsed.text
            : DEFAULTS.text,
        enabled: parsed.enabled === true,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function writeSettings(settings) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ text: settings.text, enabled: settings.enabled === true })
      );
    } catch {
      /* ignore */
    }
  }

  let settingsCache = readSettings();
  let dialog = null;

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
      #${DIALOG_ID} .ar-panel {
        min-width: 340px;
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
      #${DIALOG_ID} .ar-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        color: #4ade80;
      }
      #${DIALOG_ID} .ar-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      #${DIALOG_ID} .ar-close:hover { color: #f87171; }
      #${DIALOG_ID} .ar-row { margin-bottom: 10px; }
      #${DIALOG_ID} .ar-label {
        display: block;
        margin-bottom: 4px;
        color: #a3a3a3;
      }
      #${DIALOG_ID} .ar-hint {
        margin-top: 4px;
        color: #737373;
      }
      #${DIALOG_ID} textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        background: rgba(0, 0, 0, 0.5);
        color: #e5e5e5;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        font: inherit;
        padding: 6px;
      }
      #${DIALOG_ID} .ar-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
      }
      #${DIALOG_ID} .ar-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 10px;
      }
      #${DIALOG_ID} .ar-btn:hover { background: rgba(255, 255, 255, 0.16); }
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
    panel.className = "ar-panel";
    panel.tabIndex = -1;
    panel.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "ar-head";
    const title = document.createElement("span");
    title.textContent = "Retry \u00b7 Settings";
    const closeBtn = button("\u00d7", "ar-close");
    closeBtn.title = "close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSettings();
    });
    head.append(title, closeBtn);
    panel.appendChild(head);

    const msgRow = document.createElement("div");
    msgRow.className = "ar-row";
    const msgLabel = document.createElement("label");
    msgLabel.className = "ar-label";
    msgLabel.textContent = "Message sent on retry";
    const msg = document.createElement("textarea");
    msg.rows = 3;
    msg.spellcheck = false;
    msg.placeholder = DEFAULTS.text;
    msg.value = settingsCache.text;
    msg.addEventListener("input", () => {
      settingsCache.text = msg.value.trim() !== "" ? msg.value : DEFAULTS.text;
      writeSettings(settingsCache);
    });
    const hint = document.createElement("div");
    hint.className = "ar-hint";
    hint.textContent =
      'Sent as the prompt after an abnormal abort. Empty falls back to "' +
      DEFAULTS.text +
      '".';
    msgRow.append(msgLabel, msg, hint);
    panel.appendChild(msgRow);

    const actions = document.createElement("div");
    actions.className = "ar-actions";
    const reset = button("Reset", "ar-btn");
    reset.addEventListener("click", () => {
      settingsCache.text = DEFAULTS.text;
      writeSettings(settingsCache);
      msg.value = DEFAULTS.text;
    });
    const done = button("Close", "ar-btn");
    done.addEventListener("click", closeSettings);
    actions.append(reset, done);
    panel.appendChild(actions);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    window.addEventListener("keydown", onDialogKey, true);
    panel.focus();
    dialog = backdrop;
  }

  // ---- UI -------------------------------------------------------------------
  // The line's background/padding/font/color come from the shared overlay
  // (scripts/core.js itemStyle); this node only adds the checkbox and the
  // interactive layout it needs. Color is applied to the overlay item, not here.
  function buildUI() {
    wrap = document.createElement("label");
    Object.assign(wrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      pointerEvents: "auto",
      cursor: "pointer",
      userSelect: "none",
    });
    box = document.createElement("input");
    box.type = "checkbox";
    Object.assign(box.style, { margin: "0", pointerEvents: "auto", cursor: "pointer" });
    text = document.createElement("span");
    wrap.append(box, text);
    box.addEventListener("change", () => {
      state.enabled = box.checked;
      state.consecutive = 0;
      state.lastHandledErrorId = null;
      state.note = "";
      // only act on errors that happen after this moment, not old ones already on screen
      state.enabledAt = box.checked ? Date.now() : 0;
      settingsCache.enabled = box.checked;
      writeSettings(settingsCache);
      render();
    });
    el = overlay.setNode(ID, wrap, {
      interactive: true,
      title: "auto-retry: on an abnormal abort, send the configured message (up to 3 in a row)",
    });
  }

  function render() {
    if (!active || !el) return;
    let label = "retry";
    if (state.note) label += ` \u00b7 ${state.note}`;
    else if (state.enabled) label += ` \u00b7 ${state.consecutive}/${MAX_CONSECUTIVE}`;
    if (text.textContent !== label) text.textContent = label;
    el.style.color = state.note.startsWith("stopped") ? COLOR_ERROR : COLOR_OK;
  }

  // ---- loop -----------------------------------------------------------------
  async function tick() {
    if (!active) return;
    const id = sq.currentSessionId();
    if (!id || !sq.server || !sq.auth) {
      render();
      return;
    }
    // Nothing to do (and no point fetching the full message list) while unchecked.
    if (!state.enabled) {
      render();
      return;
    }
    if (id !== state.sessionId) {
      state.sessionId = id;
      state.consecutive = 0;
      state.lastHandledErrorId = null;
    }
    let list;
    try {
      list = await loadMessages(id);
    } catch {
      list = null;
    }
    if (!list) {
      render();
      return;
    }

    const status = classify(list);
    if (status.kind === "ok") {
      state.consecutive = 0;
      state.lastHandledErrorId = null;
      state.note = "";
    } else if (status.kind === "error" && status.id !== state.lastHandledErrorId && !sq.sessionBusy(list)) {
      state.lastHandledErrorId = status.id;
      // ignore errors that predate enabling (e.g. switching to an old errored session)
      if (state.enabled && status.created >= state.enabledAt) {
        state.consecutive += 1;
        if (state.consecutive >= MAX_CONSECUTIVE) {
          state.enabled = false;
          state.enabledAt = 0;
          box.checked = false;
          settingsCache.enabled = false;
          writeSettings(settingsCache);
          state.note = `stopped after ${MAX_CONSECUTIVE} consecutive aborts`;
        } else {
          try {
            const code = await sendContinue(id, sq.lastUserInfo(list));
            const suffix = code && code !== 204 ? ` (HTTP ${code})` : "";
            state.note = `sent retry \u00b7 aborts ${state.consecutive}/${MAX_CONSECUTIVE}${suffix}`;
          } catch (e) {
            state.note = `send failed: ${e.message}`;
          }
        }
      }
    }
    render();
  }

  function mount() {
    active = true;
    settingsCache = readSettings();
    state.enabled = settingsCache.enabled === true;
    state.enabledAt = state.enabled ? Date.now() : 0;
    state.sessionId = null;
    state.consecutive = 0;
    state.lastHandledErrorId = null;
    state.note = "";
    buildUI();
    box.checked = state.enabled;
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
    wrap = null;
    box = null;
    text = null;
    el = null;
  }

  window.__sqRetry = {
    dispose: unmount,
    tick,
    render,
    classify,
    isRunning,
    sendContinue,
    state,
    MAX_CONSECUTIVE,
    settings: () => ({ ...settingsCache }),
    openSettings,
    closeSettings,
  };
  reg.register(ID, {
    label: "Retry",
    version: "0.0.2",
    desc: 'Resends "continue" after an abnormal abort.',
    actions: [
      { label: "Settings", title: "Retry settings", onClick: openSettings },
    ],
    mount,
    unmount,
  });

  console.log("[retry] registered");
})();
