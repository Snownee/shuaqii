// Shared bottom-right overlay panel for OpenCode Desktop injection scripts.
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/session-timer.js
//
// It creates a single fixed panel in the bottom-right corner and exposes an API any
// later script can push lines into:
//
//   window.__sqOverlay.set("my-id", "some text", { color: "#4ade80", title: "tooltip" })
//   window.__sqOverlay.remove("my-id")
//   window.__sqOverlay.clear()
//
// Items are keyed by id, so re-injecting a script replaces its line instead of
// stacking duplicates. Registration order is preserved. A header line showing
// "shuaqii <version>" is kept above every item; the version comes from
// window.__shuaqii.version, which shuaqii.py injects before each script run.
//
// Hot-reload safe: re-injecting this file re-applies PANEL_STYLE/itemStyle() to the
// existing panel and items (keeping the same registry), so style edits show up on
// save instead of being ignored.
//
// It also owns the shared services under window.__sq (server/auth, active session,
// message loading, running detection, one ticker, and the toast notifier) that the
// other scripts subscribe to instead of each doing their own init + setInterval + fetch.
//
// Any script can pop a transient, dismissible notice with the shared toast system:
//
//   __sq.toast("Saved")                                  // plain text, top-right
//   __sq.toast("Line <br> two", { html: true, position: "center-right" })
//   __sq.toast.dismissAll()                              // dismiss every toast
//
// Positions: "top-right" (default), "center-right", "bottom-right".

(function () {
  const PANEL_ID = "sq-overlay";
  const VERSION_ID = "sq-overlay-version";
  const FONT = "12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const VERSION = (window.__shuaqii && window.__shuaqii.version) || "unknown";

  const PANEL_STYLE = {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "4px",
    pointerEvents: "none",
    font: FONT,
  };

  function itemStyle() {
    return {
      background: "rgba(17, 17, 17, 0.82)",
      color: "#4ade80",
      padding: "3px 8px",
      borderRadius: "4px",
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.4)",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      maxWidth: "60vw",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };
  }

  function ensureVersionLine(panel) {
    let el = document.getElementById(VERSION_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = VERSION_ID;
    }
    Object.assign(el.style, itemStyle());
    el.style.opacity = "0.65";
    el.innerHTML = "shuaqii <small>" + VERSION + "</small>";
    if (panel.firstChild !== el) panel.insertBefore(el, panel.firstChild);
    return el;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      const mount = () => (document.body || document.documentElement).appendChild(panel);
      if (document.body) mount();
      else setTimeout(mount, 200);
    }
    Object.assign(panel.style, PANEL_STYLE);
    ensureVersionLine(panel);
    return panel;
  }

  // Reuse the registry across (re-)injections so hot-reloading refreshes existing
  // styles instead of no-op'ing or duplicating the panel.
  const overlay =
    window.__sqOverlay && window.__sqOverlay.version >= 1 ? window.__sqOverlay : { version: 1 };
  const items = overlay.items instanceof Map ? overlay.items : new Map();

  // Full style write: only on creation and on injection-time refresh (see bottom).
  function styleItem(item) {
    Object.assign(item.el.style, itemStyle());
    applyOverrides(item);
  }

  // Cheap per-call write: only the properties the caller actually overrides.
  function applyOverrides(item) {
    if (item.color) item.el.style.color = item.color;
    if (item.interactive !== undefined) item.el.style.pointerEvents = item.interactive ? "auto" : "none";
  }

  function ensureItem(id) {
    let item = items.get(id);
    if (!item) {
      item = { el: document.createElement("div"), color: undefined, interactive: undefined };
      styleItem(item);
      items.set(id, item);
    }
    if (!item.el.isConnected) ensurePanel().appendChild(item.el);
    return item;
  }

  function set(id, text, opts) {
    opts = opts || {};
    const item = ensureItem(id);
    if (opts.color) item.color = opts.color;
    if (opts.interactive !== undefined) item.interactive = opts.interactive;
    if (opts.color || opts.interactive !== undefined) applyOverrides(item);
    item.el.textContent = text;
    item.el.title = opts.title || "";
    return item.el;
  }

  function setNode(id, node, opts) {
    opts = opts || {};
    const item = ensureItem(id);
    if (opts.color) item.color = opts.color;
    if (opts.interactive !== undefined) item.interactive = opts.interactive;
    if (opts.color || opts.interactive !== undefined) applyOverrides(item);
    if (opts.title !== undefined) item.el.title = opts.title;
    item.el.replaceChildren(node);
    return item.el;
  }

  function remove(id) {
    const item = items.get(id);
    if (item) {
      item.el.remove();
      items.delete(id);
    }
  }

  Object.assign(overlay, {
    version: 1,
    items,
    set,
    setNode,
    remove,
    clear() {
      for (const id of [...items.keys()]) remove(id);
    },
  });
  window.__sqOverlay = overlay;

  // -------------------------------------------------------------------------
  // Shared services (window.__sq), created once and reused by every script so
  // they don't each re-init the server, re-read localStorage, re-query the DOM,
  // or run their own timer:
  //
  //   await __sq.ready          -> server/auth/windowID resolved
  //   __sq.activeSessionId()    -> current session id (short-cached)
  //   __sq.currentSessionId()   -> current session id (never cached)
  //   __sq.messages(id, maxAge) -> message list for a session (short-cached, deduped)
  //   __sq.isSessionBusy(id)    -> whether a session is working (page-independent)
  //   __sq.sessionBusy(list)    -> same, from an already-loaded list
  //   __sq.lastUserInfo(list)   -> last user-message info in a session
  //   __sq.isRunning()          -> composer shows the stop icon (current page only)
  //   __sq.every(ms, fn)        -> subscribe to one shared ticker; returns unsubscribe
  // -------------------------------------------------------------------------
  const SUBMIT_SELECTOR = '[data-action="prompt-submit"]';
  const SESSION_CACHE_MS = 300;
  const MESSAGE_CACHE_MS = 1000;
  const TICK_MS = 250;

  let sq = window.__sq;
  if (!sq || sq.version !== 1) {
    sq = { version: 1, server: null, auth: null, windowID: null, subscribers: new Set(), timer: 0 };
    window.__sq = sq;

    let sessCache = { at: 0, id: null };
    sq.activeSessionId = function () {
      const now = Date.now();
      if (now - sessCache.at < SESSION_CACHE_MS) return sessCache.id;
      let id = null;
      try {
        const primary = sq.windowID
          ? localStorage.getItem(`opencode.desktop.window.${sq.windowID}.last-active-url`)
          : null;
        const match = primary && primary.match(/session\/([^/?#]+)/);
        if (match) {
          id = match[1];
        } else {
          for (const key of Object.keys(localStorage)) {
            if (!key.endsWith(".last-active-url")) continue;
            const m = (localStorage.getItem(key) || "").match(/session\/([^/?#]+)/);
            if (m) {
              id = m[1];
              break;
            }
          }
        }
      } catch {
        /* ignore */
      }
      sessCache = { at: now, id };
      return id;
    };

    sq.isRunning = function () {
      const btn = document.querySelector(SUBMIT_SELECTOR);
      return !!btn && btn.getAttribute("data-icon") === "stop";
    };

    const runTick = () => {
      const now = performance.now();
      for (const sub of sq.subscribers) {
        if (sub.busy || now - sub.last < sub.ms) continue;
        sub.last = now;
        sub.busy = true;
        Promise.resolve()
          .then(sub.fn)
          .catch(() => {})
          .finally(() => {
            sub.busy = false;
          });
      }
    };

    sq.every = function (ms, fn) {
      const sub = { fn, ms, last: 0, busy: false };
      sq.subscribers.add(sub);
      if (!sq.timer) sq.timer = setInterval(runTick, TICK_MS);
      return function unsubscribe() {
        sq.subscribers.delete(sub);
        if (!sq.subscribers.size && sq.timer) {
          clearInterval(sq.timer);
          sq.timer = 0;
        }
      };
    };

    sq.ready = (async () => {
      try {
        sq.server = await window.api.awaitInitialization();
      } catch {
        sq.server = null;
      }
      sq.auth = sq.server ? "Basic " + btoa(`${sq.server.username}:${sq.server.password}`) : null;
      try {
        sq.windowID = await window.api.getWindowID?.();
      } catch {
        sq.windowID = null;
      }
      return sq;
    })();
  }

  // Shared session-message loader: one HTTP request per session serves every script.
  // A short TTL (per-caller `maxAge`, default 1s) absorbs polling overlap, and an
  // in-flight map dedupes concurrent callers. Resolves to the `{ info, parts }[]`
  // array, or null when the server/auth/id is unavailable or the request fails.
  // Defined outside the version guard above so re-injecting this file also adds it to
  // an already-running __sq.
  {
    let cache = { id: null, list: null, at: 0 };
    const inflight = new Map();

    sq.messages = function (id, maxAge) {
      if (!sq.server || !sq.auth || !id) return Promise.resolve(null);
      const ttl = maxAge === undefined ? MESSAGE_CACHE_MS : maxAge;
      if (cache.id === id && cache.list && Date.now() - cache.at < ttl) {
        return Promise.resolve(cache.list);
      }
      if (inflight.has(id)) return inflight.get(id);
      const req = fetch(`${sq.server.url}/session/${encodeURIComponent(id)}/message`, {
        headers: { Authorization: sq.auth },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((list) => {
          if (!Array.isArray(list)) return null;
          cache = { id, list, at: Date.now() };
          return list;
        })
        .catch(() => null)
        .finally(() => inflight.delete(id));
      inflight.set(id, req);
      return req;
    };
  }

  // Active session id, straight from the app's persisted routing state and never
  // cached, so a just-switched session is seen immediately (activeSessionId's 300ms
  // cache can still report the previous one). Returns null when the current route is
  // not a session (e.g. a new/draft session has no id).
  sq.currentSessionId = function () {
    try {
      const w = sq.windowID;
      const keys = w ? [`opencode.desktop.window.${w}.last-active-url`] : [];
      for (const key of Object.keys(localStorage)) {
        if (key.endsWith(".last-active-url")) keys.push(key);
      }
      for (const key of keys) {
        const m = (localStorage.getItem(key) || "").match(/session\/([^/?#]+)/);
        if (m) return m[1];
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  // Whether a session is still working, judged from its message list alone so it works
  // for any session id (not just the one currently on screen): a trailing user turn, or
  // an assistant message whose time.completed is missing. Errors/aborts count as stopped.
  sq.sessionBusy = function (list) {
    if (!Array.isArray(list) || !list.length) return false;
    const info = (list[list.length - 1].info) || {};
    if (info.role === "user") return true;
    if (info.error) return false;
    return !(info.time && info.time.completed);
  };

  // Convenience over sq.sessionBusy: fetches the messages and resolves to a boolean, or
  // null when the list cannot be read.
  sq.isSessionBusy = function (id, maxAge) {
    if (!id) return Promise.resolve(null);
    return sq.messages(id, maxAge).then((list) => (list ? sq.sessionBusy(list) : null));
  };

  // Last user-message info in a session list (for agent/model passthrough on resend).
  sq.lastUserInfo = function (list) {
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const info = (list[i] && list[i].info) || {};
      if (info.role === "user") return info;
    }
    return null;
  };

  sq.overlay = overlay;

  // -------------------------------------------------------------------------
  // Shared toast system (sq.toast). One host per position, stacked bottom-up.
  // Callers get the toast element back; it also carries .dismiss().
  //
  //   __sq.toast(text, { html, duration, position, color, className, title, dedupe })
  //   __sq.toast.dismiss(el)
  //   __sq.toast.dismissAll(position?)
  //
  // Defaults: plain text, 6000ms, "top-right", dedupe identical text on.
  // Defined outside the version guard above so re-injecting this file also
  // refreshes the implementation on an already-running __sq.
  // -------------------------------------------------------------------------
  const TOAST_MS = 6000;
  const TOAST_STYLE_ID = "sq-toast-style";
  const TOAST_POSITIONS = ["top-right", "center-right", "bottom-right"];

  function ensureToastStyle() {
    let style = document.getElementById(TOAST_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = TOAST_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      .sq-toast-host {
        position: fixed;
        right: 12px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: min(420px, 70vw);
        pointer-events: none;
        font: ${FONT};
      }
      .sq-toast-host[data-position="top-right"] { top: 12px; }
      .sq-toast-host[data-position="center-right"] { top: 50%; transform: translateY(-50%); }
      .sq-toast-host[data-position="bottom-right"] { bottom: 12px; }
      .sq-toast-host .sq-toast {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        background: rgba(17, 17, 17, 0.97);
        color: #e5e5e5;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-left: 3px solid #fbbf24;
        border-radius: 6px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
        padding: 8px 10px;
        pointer-events: auto;
        opacity: 0;
        transform: translateX(12px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .sq-toast-host .sq-toast.sq-toast-in { opacity: 1; transform: translateX(0); }
      .sq-toast-host .sq-toast-text {
        flex: 1;
        min-width: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .sq-toast-host .sq-toast-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 2px;
      }
      .sq-toast-host .sq-toast-close:hover { color: #f87171; }
    `;
  }

  function ensureToastHost(position) {
    const id = `sq-toast-host-${position}`;
    let host = document.getElementById(id);
    if (!host) {
      host = document.createElement("div");
      host.id = id;
      host.className = "sq-toast-host";
      host.dataset.position = position;
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }

  function showToast(text, opts) {
    opts = opts || {};
    ensureToastStyle();
    const position = TOAST_POSITIONS.indexOf(opts.position) >= 0 ? opts.position : "top-right";
    const host = ensureToastHost(position);
    const html = opts.html === true;
    const content = String(text);
    // Don't stack identical toasts (e.g. repeated cross-session attempts).
    if (opts.dedupe !== false) {
      for (const existing of host.querySelectorAll(".sq-toast-text")) {
        const same = html ? existing.innerHTML === content : existing.textContent === content;
        if (same) return existing.parentElement;
      }
    }
    const el = document.createElement("div");
    el.className = "sq-toast";
    if (opts.className) el.classList.add(opts.className);
    if (opts.color) el.style.borderLeftColor = opts.color;
    if (opts.title) el.title = opts.title;
    const body = document.createElement("span");
    body.className = "sq-toast-text";
    if (html) body.innerHTML = content;
    else body.textContent = content;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "sq-toast-close";
    close.textContent = "\u00d7";
    close.title = "dismiss";
    el.append(body, close);

    const duration = typeof opts.duration === "number" ? opts.duration : TOAST_MS;
    let timer = duration > 0 ? setTimeout(dismiss, duration) : 0;
    function dismiss() {
      clearTimeout(timer);
      el.classList.remove("sq-toast-in");
      setTimeout(() => el.remove(), 250);
    }
    close.addEventListener("click", dismiss);
    el.dismiss = dismiss;

    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("sq-toast-in"));
    return el;
  }

  sq.toast = function (text, opts) {
    return showToast(text, opts);
  };
  sq.toast.show = showToast;
  sq.toast.dismiss = function (el) {
    if (el && typeof el.dismiss === "function") el.dismiss();
  };
  sq.toast.dismissAll = function (position) {
    const hosts =
      position && TOAST_POSITIONS.indexOf(position) >= 0
        ? [document.getElementById(`sq-toast-host-${position}`)].filter(Boolean)
        : [...document.querySelectorAll(".sq-toast-host")];
    for (const host of hosts) {
      for (const el of [...host.querySelectorAll(".sq-toast")]) {
        if (typeof el.dismiss === "function") el.dismiss();
      }
    }
  };

  // -------------------------------------------------------------------------
  // Script registry (window.__sqScripts). Feature scripts register their label
  // plus lifecycle hooks; core owns the enabled/disabled state and decides
  // whether to mount, and scripts/mod-list.js renders the list. The registry
  // (entries + subscribers) is reused across injections so editing this file
  // refreshes the methods without dropping already-registered scripts.
  //
  //   register(id, { label, version?, desc?, order?, locked?, enabled?, actions?, mount?, unmount? })
  //     enabled is the default on first load (absent = true); a user toggle in
  //     mod-list persists and overrides it from then on.
  //   enabled(id)            -> whether the script is currently enabled
  //   setEnabled(id, bool)   -> mount/unmount + persist to localStorage
  //   addAction(id, action)  -> { label, title?, onClick, color? }
  //   onChange(fn)           -> subscribe to registry changes; returns unsubscribe
  //   list()                 -> ordered snapshot for the UI
  //   unregister(id)
  // -------------------------------------------------------------------------
  const MOD_STORE_KEY = "shuaqii.mods";
  const registry =
    window.__sqScripts && window.__sqScripts.entries instanceof Map
      ? window.__sqScripts
      : { entries: new Map(), subscribers: new Set() };

  function readModState() {
    try {
      const raw = localStorage.getItem(MOD_STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeModState(state) {
    try {
      localStorage.setItem(MOD_STORE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  // The default a script declares at registration (absent = enabled), used until
  // the user flips it in mod-list; after that the persisted value wins.
  function defaultModEnabled(id) {
    const entry = registry.entries.get(id);
    return entry ? entry.enabled : true;
  }

  function modEnabled(id) {
    const rec = readModState()[id];
    return rec && typeof rec.enabled === "boolean" ? rec.enabled : defaultModEnabled(id);
  }

  function persistModEnabled(id, enabled) {
    const state = readModState();
    state[id] = Object.assign({}, state[id], { enabled: enabled !== false });
    writeModState(state);
  }

  function notifyMods() {
    for (const fn of [...registry.subscribers]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function mountEntry(entry) {
    if (entry.mounted || !entry.mount) return;
    try {
      entry.mount();
      entry.mounted = true;
    } catch (e) {
      console.warn("[sqScripts] mount failed:", entry.id, e);
    }
  }

  function unmountEntry(entry) {
    if (!entry.mounted || !entry.unmount) return;
    try {
      entry.unmount();
    } catch (e) {
      console.warn("[sqScripts] unmount failed:", entry.id, e);
    }
    entry.mounted = false;
  }

  Object.assign(registry, {
    version: 1,
    register(id, meta) {
      meta = meta || {};
      const prev = registry.entries.get(id);
      if (prev) unmountEntry(prev);
      const entry = {
        id,
        label: meta.label || id,
        version: typeof meta.version === "string" ? meta.version : "",
        desc: typeof meta.desc === "string" ? meta.desc : "",
        order: typeof meta.order === "number" ? meta.order : 100,
        locked: meta.locked === true,
        enabled: meta.enabled !== false,
        actions: Array.isArray(meta.actions) ? meta.actions.slice() : [],
        mount: typeof meta.mount === "function" ? meta.mount : null,
        unmount: typeof meta.unmount === "function" ? meta.unmount : null,
        mounted: false,
      };
      registry.entries.set(id, entry);
      if (modEnabled(id)) mountEntry(entry);
      notifyMods();
      return entry;
    },
    enabled: modEnabled,
    setEnabled(id, enabled) {
      const entry = registry.entries.get(id);
      if (entry && entry.locked) return;
      persistModEnabled(id, enabled !== false);
      if (entry) {
        if (enabled !== false) mountEntry(entry);
        else unmountEntry(entry);
      }
      notifyMods();
    },
    addAction(id, action) {
      const entry = registry.entries.get(id);
      if (!entry || !action) return false;
      entry.actions.push(action);
      notifyMods();
      return true;
    },
    onChange(fn) {
      registry.subscribers.add(fn);
      return () => registry.subscribers.delete(fn);
    },
    unregister(id) {
      const entry = registry.entries.get(id);
      if (!entry) return;
      unmountEntry(entry);
      registry.entries.delete(id);
      notifyMods();
    },
    list() {
      const index = new Map([...registry.entries.keys()].map((key, i) => [key, i]));
      return [...registry.entries.values()]
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          version: entry.version,
          desc: entry.desc,
          order: entry.order,
          locked: entry.locked,
          actions: entry.actions.slice(),
          enabled: modEnabled(entry.id),
          mounted: entry.mounted,
        }))
        .sort((a, b) => a.order - b.order || index.get(a.id) - index.get(b.id));
    },
  });
  window.__sqScripts = registry;

  // Refresh the panel and every existing item on each injection (style hot reload).
  ensurePanel();
  for (const item of items.values()) {
    styleItem(item);
    if (!item.el.isConnected) ensurePanel().appendChild(item.el);
  }
})();
