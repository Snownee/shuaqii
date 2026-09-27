// Paints a random image from theme-diy/bg/ as the background of the app's <main>
// element, crossfading to a different random image whenever the active session changes.
// Requires scripts/core.js to be injected first (window.__sq shared services and
// the window.__sqScripts registry it registers itself with).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/theme-diy.js
//
// The renderer (oc://renderer/index.html) cannot read project files from disk itself,
// so the folder is listed through the bundled server's GET /file endpoint and each
// image is loaded as base64 through GET /file/content (the same endpoints the app uses
// to browse and preview files). Paths are resolved against the active session's project
// directory, so "theme-diy/bg" means <project>/theme-diy/bg. Any file is a candidate;
// loadImage keeps only those the server reports with an image/* mimeType, so arbitrary
// image formats work. The current and incoming images ride on main::before / main::after
// (each opacity-transitioned), and the whole rule set lives in a <style> tag so it
// survives the app re-rendering <main>.
//
// Its row in the mod list carries a "Settings" button opening a small dialog where the
// background colour opacity (the dark scrim over the image) and extra CSS rules can
// be edited; both are applied live and persisted to localStorage["shuaqii.theme-diy"].

(async () => {
  const sq = window.__sq;
  const reg = window.__sqScripts;
  if (!sq || !reg) {
    console.warn("[theme-diy] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "theme-diy";
  const STYLE_ID = "sq-theme-diy-style";
  const SETTINGS_STYLE_ID = "sq-theme-diy-settings-style";
  const UI_STYLE_ID = "sq-theme-diy-ui-style";
  const DIALOG_ID = "sq-themediy-backdrop";
  const STORE_KEY = "shuaqii.theme-diy";
  const BG_DIR = "theme-diy/bg";
  const FADE_MS = 500;
  const DEFAULTS = { alpha: 0.5, css: "" };

  // Two stacked image layers (main::before / main::after) hold the current and next
  // background so a switch can crossfade instead of swapping the image in an instant.
  function emptyLayers() {
    return { a: { uri: null, on: false }, b: { uri: null, on: false } };
  }

  const state = {
    sessionId: null,
    directory: null,
    asset: null,
    dataUri: null,
    bg: emptyLayers(),
    status: "",
    error: false,
  };

  let active = false;
  let unsubscribe = null;

  // ---- settings -------------------------------------------------------------
  function readSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
      return {
        alpha:
          typeof parsed.alpha === "number"
            ? Math.min(1, Math.max(0, parsed.alpha))
            : DEFAULTS.alpha,
        css: typeof parsed.css === "string" ? parsed.css : DEFAULTS.css,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function writeSettings(settings) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ alpha: settings.alpha, css: settings.css }),
      );
    } catch {
      /* ignore */
    }
  }

  // In-memory copy so the render path never touches localStorage, and writes are
  // debounced so dragging the slider / typing CSS does not hit localStorage per event.
  let settingsCache = readSettings();
  let persistTimer = 0;

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      writeSettings(settingsCache);
    }, 300);
  }

  function flushPersist() {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    persistTimer = 0;
    writeSettings(settingsCache);
  }

  async function fetchJson(path) {
    if (!sq.server || !sq.auth) return null;
    try {
      const res = await fetch(`${sq.server.url}${path}`, {
        headers: { Authorization: sq.auth },
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // The asset is relative to the active session's project; when no session is active
  // yet, fall back to the server's own working directory.
  async function resolveDirectory(id) {
    if (id) {
      const info = await fetchJson(`/session/${encodeURIComponent(id)}`);
      if (info && info.directory) return info.directory;
    }
    const path = await fetchJson("/path");
    return path && path.directory ? path.directory : null;
  }

  // List theme-diy/bg via the server's directory endpoint. Every regular file is a
  // candidate; loadImage rejects the ones whose mimeType is not an image, so no
  // extension allowlist is needed and any image format is supported.
  let assetCache = { directory: null, assets: null };

  async function listAssets(directory) {
    if (assetCache.directory === directory && assetCache.assets) return assetCache.assets;
    const query = `?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(BG_DIR)}`;
    const list = await fetchJson(`/file${query}`);
    if (!Array.isArray(list)) throw new Error(`${BG_DIR} not found`);
    const assets = list
      .filter((e) => e && e.type === "file" && e.name)
      .map((e) => `${BG_DIR}/${e.name}`);
    assetCache = { directory, assets };
    return assets;
  }

  // Shuffle so the choice is random, then move the currently shown image to the end so a
  // different one is tried first (the "another random image" requested on session switch).
  function orderAssets(assets) {
    const order = assets.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.length > 1 && state.asset) {
      const i = order.indexOf(state.asset);
      if (i !== -1) order.push(order.splice(i, 1)[0]);
    }
    return order;
  }

  async function loadImage(directory) {
    const assets = await listAssets(directory);
    if (!assets.length) throw new Error(`no files in ${BG_DIR}`);
    let lastErr = null;
    for (const asset of orderAssets(assets)) {
      try {
        const query = `?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(asset)}`;
        const file = await fetchJson(`/file/content${query}`);
        if (!file || file.encoding !== "base64" || !file.content)
          throw new Error("not a binary file");
        const mime = file.mimeType || "image/jpeg";
        if (!/^image\//i.test(mime)) throw new Error("not an image");
        state.asset = asset;
        return `data:${mime};base64,${file.content}`;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`no loadable image in ${BG_DIR}`);
  }

  function cssUrl(uri) {
    return uri ? `url("${uri}")` : "none";
  }

  // The layer rules embed the (often multi-MB) base64 image URIs, so they live in their
  // own <style> tag, apart from the tiny settings rules. Editing the scrim opacity or
  // extra CSS then never rebuilds/reparses the image data, and vice versa. A revision
  // counter lets apply() skip even building the big string when no image changed.
  let layersRev = 0;
  let layersDrawnRev = -1;
  let settingsCss = null;

  function buildLayerCss() {
    const a = state.bg.a;
    const b = state.bg.b;
    return `
      main::before,
      main::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        transition: opacity ${FADE_MS}ms ease;
      }

      main::before {
        background-image: ${cssUrl(a.uri)};
        opacity: ${a.on ? 1 : 0};
      }

      main::after {
        background-image: ${cssUrl(b.uri)};
        opacity: ${b.on ? 1 : 0};
      }`;
  }

  function buildSettingsCss() {
    const extra = settingsCache.css.trim() ? `\n${settingsCache.css}\n` : "";
    return `
      main .bg-v2-background-bg-base {
        background-color: rgba(0, 0, 0, ${settingsCache.alpha}) !important;
      }

      [data-slot="session-turn-diffs-header"] {
        background-color: transparent !important;
      }

      [data-component="sticky-accordion-header"],
      [data-component="session-new-design"] {
        background-color: transparent !important;
      }

      ${extra}`;
  }

  // Decode the data URI before handing it to the layer so the fade reveals a ready
  // image rather than popping in once the browser finishes decoding it.
  function preload(uri) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = () => resolve();
      img.src = uri;
    });
  }

  // Put the new image on whichever layer is currently hidden, then flip both opacities
  // so the old image fades out as the new one fades in.
  function setImage(uri) {
    const next = state.bg.a.on ? "b" : "a";
    const other = next === "a" ? "b" : "a";
    state.bg[next] = { uri, on: true };
    state.bg[other] = { uri: state.bg[other].uri, on: false };
    layersRev++;
  }

  function ensureSheet(id) {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    return style;
  }

  // Only touch the DOM when a sheet's content actually changed, so a settings edit never
  // rebuilds the layer sheet (and its huge image data URI) and vice versa.
  function apply() {
    if (!active) return;
    if (layersRev !== layersDrawnRev || !document.getElementById(STYLE_ID)) {
      ensureSheet(STYLE_ID).textContent = buildLayerCss();
      layersDrawnRev = layersRev;
    }
    const nextSettings = buildSettingsCss();
    if (nextSettings !== settingsCss || !document.getElementById(SETTINGS_STYLE_ID)) {
      ensureSheet(SETTINGS_STYLE_ID).textContent = nextSettings;
      settingsCss = nextSettings;
    }
  }

  let loading = false;

  async function refresh() {
    if (!active || loading) return;
    const id = sq.currentSessionId();
    if (id && id !== state.sessionId) {
      state.sessionId = id;
      state.directory = null;
      state.dataUri = null;
    }
    if (state.dataUri && state.directory) return;

    loading = true;
    try {
      const directory = await resolveDirectory(id);
      if (id !== sq.currentSessionId()) return;
      if (!directory) {
        state.status = "theme-diy \u00b7 no project directory";
        state.error = true;
        return;
      }
      state.directory = directory;
      try {
        const uri = await loadImage(directory);
        if (id !== sq.currentSessionId()) return;
        await preload(uri);
        if (id !== sq.currentSessionId()) return;
        state.dataUri = uri;
        setImage(uri);
        apply();
        state.status = `theme-diy \u00b7 main \u2190 ${state.asset}`;
        state.error = false;
      } catch (e) {
        state.dataUri = null;
        state.status = `theme-diy \u00b7 ${BG_DIR}: ${e.message}`;
        state.error = true;
      }
    } finally {
      loading = false;
    }
  }

  // ---- settings dialog ------------------------------------------------------
  let dialog = null;

  function ensureUiStyle() {
    let style = document.getElementById(UI_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = UI_STYLE_ID;
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
      #${DIALOG_ID} .td-panel {
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
      #${DIALOG_ID} .td-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        color: #4ade80;
      }
      #${DIALOG_ID} .td-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      #${DIALOG_ID} .td-close:hover { color: #f87171; }
      #${DIALOG_ID} .td-row { margin-bottom: 10px; }
      #${DIALOG_ID} .td-label {
        display: block;
        margin-bottom: 4px;
        color: #a3a3a3;
      }
      #${DIALOG_ID} .td-range {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${DIALOG_ID} input[type="range"] { flex: 1; }
      #${DIALOG_ID} .td-val {
        width: 34px;
        text-align: right;
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
      #${DIALOG_ID} .td-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
      }
      #${DIALOG_ID} .td-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 10px;
      }
      #${DIALOG_ID} .td-btn:hover { background: rgba(255, 255, 255, 0.16); }
    `;
  }

  function closeSettings() {
    if (!dialog) return;
    flushPersist();
    dialog.remove();
    dialog = null;
    window.removeEventListener("keydown", onDialogKey, true);
    document.getElementById(UI_STYLE_ID)?.remove();
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
    ensureUiStyle();

    const backdrop = document.createElement("div");
    backdrop.id = DIALOG_ID;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeSettings();
    });

    const panel = document.createElement("div");
    panel.className = "td-panel";
    panel.tabIndex = -1;
    panel.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "td-head";
    const title = document.createElement("span");
    title.textContent = "Theme DIY \u00b7 Settings";
    const closeBtn = button("\u00d7", "td-close");
    closeBtn.title = "close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSettings();
    });
    head.append(title, closeBtn);
    panel.appendChild(head);

    // opacity of the dark scrim over the background image
    const alphaRow = document.createElement("div");
    alphaRow.className = "td-row";
    const alphaLabel = document.createElement("label");
    alphaLabel.className = "td-label";
    alphaLabel.textContent = "Background opacity (0 = none, 1 = black)";
    const rangeWrap = document.createElement("div");
    rangeWrap.className = "td-range";
    const alpha = document.createElement("input");
    alpha.type = "range";
    alpha.min = "0";
    alpha.max = "1";
    alpha.step = "0.05";
    alpha.value = String(settingsCache.alpha);
    const alphaVal = document.createElement("span");
    alphaVal.className = "td-val";
    alphaVal.textContent = settingsCache.alpha.toFixed(2);
    alpha.addEventListener("input", () => {
      settingsCache.alpha = Number(alpha.value);
      alphaVal.textContent = settingsCache.alpha.toFixed(2);
      apply();
      schedulePersist();
    });
    rangeWrap.append(alpha, alphaVal);
    alphaRow.append(alphaLabel, rangeWrap);
    panel.appendChild(alphaRow);

    // extra CSS appended verbatim to the theme <style>
    const cssRow = document.createElement("div");
    cssRow.className = "td-row";
    const cssLabel = document.createElement("label");
    cssLabel.className = "td-label";
    cssLabel.textContent = "Extra CSS";
    const css = document.createElement("textarea");
    css.rows = 8;
    css.spellcheck = false;
    css.placeholder = "/* extra rules, applied live */";
    css.value = settingsCache.css;
    css.addEventListener("input", () => {
      settingsCache.css = css.value;
      apply();
      schedulePersist();
    });
    cssRow.append(cssLabel, css);
    panel.appendChild(cssRow);

    const actions = document.createElement("div");
    actions.className = "td-actions";
    const reset = button("Reset", "td-btn");
    reset.addEventListener("click", () => {
      settingsCache = { ...DEFAULTS };
      writeSettings(settingsCache);
      alpha.value = String(DEFAULTS.alpha);
      alphaVal.textContent = DEFAULTS.alpha.toFixed(2);
      css.value = DEFAULTS.css;
      apply();
    });
    const done = button("Close", "td-btn");
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
  function mount() {
    active = true;
    state.sessionId = null;
    state.directory = null;
    state.asset = null;
    state.dataUri = null;
    state.bg = emptyLayers();
    state.status = "";
    state.error = false;
    assetCache = { directory: null, assets: null };
    settingsCache = readSettings();
    layersRev = 0;
    layersDrawnRev = -1;
    settingsCss = null;
    apply();
    unsubscribe = sq.every(500, () => {
      refresh();
    });
    refresh();
  }

  function unmount() {
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    closeSettings();
    flushPersist();
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(SETTINGS_STYLE_ID)?.remove();
    layersDrawnRev = -1;
    settingsCss = null;
  }

  window.__sqThemeDiy = {
    dispose: unmount,
    refresh,
    apply,
    state,
    BG_DIR,
    settings: () => ({ ...settingsCache }),
    openSettings,
    closeSettings,
  };
  reg.register(ID, {
    label: "Theme DIY",
    version: "0.0.1",
    desc: "Random background image, custom css.",
    enabled: false,
    actions: [
      { label: "Settings", title: "Theme DIY settings", onClick: openSettings },
    ],
    mount,
    unmount,
  });

  console.log("[theme-diy] registered");
})();
