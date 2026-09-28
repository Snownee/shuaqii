// Paints an image from theme-diy/bg/ as the background of the app's <main> element. On a
// session switch the image changes: each page (session) remembers the picture it first
// rolled (see "page memory" below), so a page keeps the same background across reloads,
// while a brand-new page gets a fresh random one.
// Requires scripts/core.js to be injected first (window.__sq shared services and
// the window.__sqScripts registry it registers itself with).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/theme-diy.js
//
// The renderer (oc://renderer/index.html) cannot read project files from disk itself,
// so the folder is listed through the bundled server's GET /file endpoint and each
// image is loaded as base64 through GET /file/content (the same endpoints the app uses
// to browse and preview files). The pool is read from a fixed directory
// (settings.dir, defaulting to the repo directory shuaqii.py injects as
// window.__shuaqii.projectDir), so every session draws from the same theme-diy/bg
// regardless of the active project. Any file is a candidate;
// loadImage keeps only those the server reports with an image/* mimeType, so arbitrary
// image formats work. The current and incoming images ride on main::before / main::after
// (each opacity-transitioned), and the whole rule set lives in a <style> tag so it
// survives the app re-rendering <main>.
//
// Page memory: once a page's background is set it is written to
// localStorage["shuaqii.theme-diy"].pages as { "<sessionId>": { asset, at } } (asset is a
// BG_DIR-relative path, at the LRU stamp). Revisiting that page reuses the remembered
// image (marked "reuse" in the overlay); a path that no longer loads is dropped and
// replaced by a new random pick. The map is LRU-capped at MAX_PAGES (50).
//
// Its row in the mod list carries a "Settings" button opening a small dialog where the
// background directory, background colour opacity (the dark scrim over the image) and
// extra CSS rules can be edited; all are applied live and persisted to
// localStorage["shuaqii.theme-diy"]. Reset restores those defaults and clears the page
// memory too.

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
  // The repo directory shuaqii.py reports (via core.js). Scripts live there, so
  // theme-diy/bg resolves without hard-coding a machine-specific absolute path.
  const DEFAULT_ROOT = sq.projectDir || "";
  const MAX_PAGES = 50;
  const FADE_MS = 500;
  const DEFAULTS = { alpha: 0.5, css: "", dir: DEFAULT_ROOT, pages: {} };

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
  // `pages` remembers the background chosen for each page (session id) so a page
  // keeps the same image across reloads instead of re-rolling every time. Each entry
  // is { asset, at } where asset is a BG_DIR-relative path and at is the LRU stamp.
  // Sanitize on read: drop malformed entries and cap at MAX_PAGES.
  // Keep only the MAX_PAGES most recently used (larger `at` wins).
  function prunePages(pages) {
    const ids = Object.keys(pages);
    if (ids.length <= MAX_PAGES) return pages;
    ids
      .sort((a, b) => (pages[b].at || 0) - (pages[a].at || 0))
      .slice(MAX_PAGES)
      .forEach((id) => delete pages[id]);
    return pages;
  }

  function readPages(parsed) {
    const pages = {};
    const raw = parsed && parsed.pages;
    if (raw && typeof raw === "object") {
      for (const [id, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.asset !== "string" || !entry.asset) continue;
        pages[id] = {
          asset: entry.asset,
          at: typeof entry.at === "number" ? entry.at : 0,
        };
      }
    }
    return prunePages(pages);
  }

  // Remember the asset shown for a page and refresh its LRU stamp (Q14: every reuse or
  // write counts as a use). Prunes to MAX_PAGES, then persists via the debounced writer.
  function rememberPage(id, asset) {
    if (!id) return;
    settingsCache.pages[id] = { asset, at: Date.now() };
    prunePages(settingsCache.pages);
    schedulePersist();
  }

  function forgetAllPages() {
    settingsCache.pages = {};
    schedulePersist();
  }

  function readSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return { ...DEFAULTS, pages: {} };
      return {
        alpha:
          typeof parsed.alpha === "number"
            ? Math.min(1, Math.max(0, parsed.alpha))
            : DEFAULTS.alpha,
        css: typeof parsed.css === "string" ? parsed.css : DEFAULTS.css,
        dir:
          typeof parsed.dir === "string" && parsed.dir.trim()
            ? parsed.dir.trim()
            : DEFAULTS.dir,
        pages: readPages(parsed),
      };
    } catch {
      return { ...DEFAULTS, pages: {} };
    }
  }

  function writeSettings(settings) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          alpha: settings.alpha,
          css: settings.css,
          dir: settings.dir,
          pages: settings.pages,
        }),
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

  // The pool is read from a fixed directory (settings.dir), independent of the active
  // session's project, so every session draws from the same theme-diy/bg folder.
  function bgRoot() {
    return settingsCache.dir || DEFAULT_ROOT;
  }

  // List theme-diy/bg via the server's directory endpoint. Every regular file is a
  // candidate; loadImage rejects the ones whose mimeType is not an image, so no
  // extension allowlist is needed and any image format is supported.
  let assetCache = { directory: null, assets: null };

  async function listAssets() {
    const directory = bgRoot();
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

  // Fetch one specific asset (BG_DIR-relative) and validate it. Throws on anything the
  // server does not return as a binary image, so a stale remembered path self-heals.
  async function fetchAsset(asset) {
    const directory = bgRoot();
    const query = `?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(asset)}`;
    const file = await fetchJson(`/file/content${query}`);
    if (!file || file.encoding !== "base64" || !file.content)
      throw new Error("not a binary file");
    const mime = file.mimeType || "image/jpeg";
    if (!/^image\//i.test(mime)) throw new Error("not an image");
    return { uri: `data:${mime};base64,${file.content}`, asset };
  }

  // Load one remembered asset by path.
  function loadAsset(asset) {
    return fetchAsset(asset);
  }

  // Resolves to { uri, asset } WITHOUT mutating state.asset: the pick must not count as
  // "currently shown" until refresh actually commits it via setImage. Otherwise a load
  // that gets discarded (session switched mid-load) would still move the exclusion mark,
  // letting the next pick re-select the image already on screen and look like no switch.
  async function loadImage() {
    const assets = await listAssets();
    if (!assets.length) throw new Error(`no files in ${BG_DIR}`);
    let lastErr = null;
    for (const asset of orderAssets(assets)) {
      try {
        return await fetchAsset(asset);
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

  // Debug signal: a toast on every detected page (session) switch. The first observation
  // after mount never counts: state.sessionId starts null, so only a change from a known
  // session fires. dedupe is off so back-to-back switches each stack their own notice.
  function notifySwitch() {
  }

  async function refresh() {
    if (!active || loading) return;
    const id = sq.currentSessionId();
    if (id && id !== state.sessionId) {
      if (state.sessionId !== null) notifySwitch();
      state.sessionId = id;
      state.directory = null;
      state.dataUri = null;
    }
    if (state.dataUri && state.directory) return;

    loading = true;
    try {
      state.directory = bgRoot();
      const remembered = settingsCache.pages[id] ? settingsCache.pages[id].asset : null;
      try {
        // Prefer the image already remembered for this page; fall back to a fresh random
        // pick (which excludes the one on screen). A remembered path that no longer loads
        // throws and is replaced by that pick, self-healing the stale entry.
        let picked = null;
        if (remembered) {
          try {
            picked = await loadAsset(remembered);
          } catch {
            picked = null;
          }
        }
        const reused = !!picked;
        if (!picked) picked = await loadImage();
        if (id !== sq.currentSessionId()) return;
        await preload(picked.uri);
        if (id !== sq.currentSessionId()) return;
        setImage(picked.uri);
        state.dataUri = picked.uri;
        state.asset = picked.asset;
        rememberPage(id, picked.asset);
        apply();
        state.status = reused
          ? `theme-diy \u00b7 reuse \u2192 ${state.asset}`
          : `theme-diy \u00b7 main \u2190 ${state.asset}`;
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
      #${DIALOG_ID} textarea,
      #${DIALOG_ID} input[type="text"] {
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

    // directory that holds theme-diy/bg, fixed so every session draws from the same pool
    const dirRow = document.createElement("div");
    dirRow.className = "td-row";
    const dirLabel = document.createElement("label");
    dirLabel.className = "td-label";
    dirLabel.textContent = "Background directory (theme-diy/bg lives here)";
    const dir = document.createElement("input");
    dir.type = "text";
    dir.spellcheck = false;
    dir.placeholder = DEFAULT_ROOT;
    dir.value = settingsCache.dir;
    // reload on commit (blur / Enter) rather than per keystroke
    dir.addEventListener("change", () => {
      settingsCache.dir = dir.value.trim() || DEFAULT_ROOT;
      dir.value = settingsCache.dir;
      assetCache = { directory: null, assets: null };
      state.dataUri = null;
      state.directory = null;
      schedulePersist();
      refresh();
    });
    dirRow.append(dirLabel, dir);
    panel.appendChild(dirRow);

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
      // One-click factory reset: alpha, css, dir AND all remembered pages (Q15).
      settingsCache = { ...DEFAULTS, pages: {} };
      writeSettings(settingsCache);
      dir.value = DEFAULTS.dir;
      alpha.value = String(DEFAULTS.alpha);
      alphaVal.textContent = DEFAULTS.alpha.toFixed(2);
      css.value = DEFAULTS.css;
      assetCache = { directory: null, assets: null };
      state.dataUri = null;
      state.directory = null;
      apply();
      refresh();
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
    pages: () => ({ ...settingsCache.pages }),
    clearPages: () => {
      forgetAllPages();
      state.dataUri = null;
      state.directory = null;
      refresh();
    },
    openSettings,
    closeSettings,
  };
  reg.register(ID, {
    label: "Theme DIY",
    version: "0.0.2",
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
