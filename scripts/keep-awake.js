// Tells you whether the machine is being kept awake while the current session works.
//
// One file, two halves. It is auto-loaded into the renderer like any scripts/*.js, and —
// because of the "@shuaqii:main" marker below — shuaqii also injects it into the Electron
// main process through the Node inspector it opens with --inspect=<port>:
//
//   python shuaqii.py --launch --restart
//
// The renderer can't reach Electron's powerSaveBlocker, and OpenCode Desktop's permission
// allow-list only admits "clipboard-sanitized-write" and "notifications" (so the Web Wake
// Lock API is always rejected). The main half is therefore what actually keeps the machine
// awake, and the two halves talk over a small localhost HTTP bridge the main half hosts:
//
//   renderer -> main   the main half starts an HTTP server on 127.0.0.1 (ephemeral port,
//                      published to the renderer as window.__shuaqiiMain["keep-awake"]).
//                      The renderer POSTs { enabled } on mount, on every tick, and via
//                      navigator.sendBeacon on unmount, so disabling the mod in the list
//                      releases the blocker immediately instead of lingering.
//   main -> renderer   the main half publishes its status (busy/enabled/held/port) back
//                      through webContents.executeJavaScript; the renderer displays it.
//
// Why main still polls busy itself: renderer timers are throttled when the window is
// hidden, so a session that starts while minimized might not be reported for up to a
// minute. The main-side poll runs on the main process timer (never throttled) and reads
// window.__sq.isSessionBusy(...) directly, so the block is taken promptly either way.
//
// The marker is how shuaqii knows to send this file to the main process as well.
// @shuaqii:main

(function () {
  // No window/document means we're in the Electron main process (a plain Node context).
  if (typeof window === "undefined" || typeof document === "undefined") {
    runMain();
  } else {
    runRenderer();
  }

  // -------------------------------------------------------------------------
  // Main-process half: localhost bridge + powerSaveBlocker ownership.
  // -------------------------------------------------------------------------
  function runMain() {
    const electron =
      (typeof require === "function" && require("electron")) ||
      (process.mainModule && process.mainModule.require("electron"));
    if (!electron || !electron.powerSaveBlocker || !electron.webContents) {
      console.warn("[keep-awake] not running under Electron; skipping main half");
      return;
    }

    const { powerSaveBlocker, webContents } = electron;
    const http = require("http");
    const crypto = require("crypto");

    const ID = "keep-awake";
    const POLL_MS = 1000;
    const RENDERER_PREFIX = "oc://renderer";
    // A renderer that stops reporting (crash, reload) must not pin the machine awake; the
    // heartbeat is ~1/s normally, but background throttling can stretch it to ~1/min.
    const REPORT_TTL_MS = 180000;

    const root = (globalThis.__shuaqiiMain = globalThis.__shuaqiiMain || {});
    if (root[ID] && typeof root[ID].dispose === "function") {
      try {
        root[ID].dispose();
      } catch {
        /* ignore */
      }
    }

    // Stamped by shuaqii's main bootstrap; lets its sweep dispose this half if the file
    // is later removed (see MainInjector.inject_all in shuaqii.py).
    const pass = globalThis.__shuaqii && globalThis.__shuaqii.pass;
    const token = crypto.randomBytes(16).toString("hex");
    const report = { enabled: false, at: 0 };
    let httpPort = null;
    let blockerId = null;
    let busy = false;

    function held() {
      return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
    }

    // The renderer half told us it exists recently and is still enabled.
    function enabled() {
      return report.enabled === true && Date.now() - report.at < REPORT_TTL_MS;
    }

    function rendererWindows() {
      return webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && (wc.getURL() || "").startsWith(RENDERER_PREFIX));
    }

    function status() {
      return { busy: busy, enabled: enabled(), held: held(), blockerId: blockerId, port: httpPort, token: token };
    }

    // Mirror the current state into every renderer so the overlay can show it.
    function publish() {
      const expr =
        `(window.__shuaqiiMain = window.__shuaqiiMain || {}),` +
        `(window.__shuaqiiMain[${JSON.stringify(ID)}] = ${JSON.stringify(status())})`;
      for (const wc of rendererWindows()) {
        wc.executeJavaScript(expr, false).catch(() => {});
      }
    }

    // Hold the blocker only while a session is busy AND the renderer half has told us the
    // mod is still enabled. Idempotent so it can run every tick (enabled() can expire).
    function syncBlocker() {
      const want = busy && enabled();
      if (want) {
        if (!held()) blockerId = powerSaveBlocker.start("prevent-app-suspension");
      } else if (blockerId !== null) {
        try {
          if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
        } catch {
          /* ignore */
        }
        blockerId = null;
      }
    }

    // Ask one renderer whether its current session is working. Resolves false whenever
    // scripts/core.js is absent or anything throws, so an error never pins the machine
    // awake.
    const PROBE = `(async () => {
      const s = window.__sq;
      if (!s || !s.currentSessionId || !s.isSessionBusy) return false;
      const id = s.currentSessionId();
      if (!id) return false;
      try { return (await s.isSessionBusy(id)) === true; } catch { return false; }
    })()`;

    async function tick() {
      let any = false;
      for (const wc of rendererWindows()) {
        try {
          if ((await wc.executeJavaScript(PROBE, true)) === true) {
            any = true;
            break;
          }
        } catch {
          /* a renderer mid-reload simply doesn't count this round */
        }
      }
      busy = any;
      syncBlocker();
      publish();
    }

    // Localhost bridge. POST /keep-awake { enabled, at, token }. CORS-open so the oc://
    // renderer can reach it; text/plain bodies keep it a simple request (no preflight).
    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/keep-awake") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) req.destroy();
      });
      req.on("end", () => {
        let msg = null;
        try {
          msg = JSON.parse(body || "{}");
        } catch {
          /* ignore */
        }
        if (!msg || msg.token !== token) {
          res.writeHead(403);
          res.end();
          return;
        }
        const at = typeof msg.at === "number" ? msg.at : Date.now();
        // `at` lets a later unmount signal win over an in-flight heartbeat.
        if (typeof msg.enabled === "boolean" && at >= report.at) {
          report.enabled = msg.enabled;
          report.at = at;
          syncBlocker();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: enabled(), held: held() }));
      });
    });
    server.on("error", (e) => console.warn("[keep-awake] bridge:", e && e.message));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      httpPort = addr && typeof addr === "object" ? addr.port : null;
      publish();
    });

    const timer = setInterval(() => tick().catch(() => {}), POLL_MS);

    root[ID] = {
      id: ID,
      pass: pass,
      tick,
      dispose() {
        clearInterval(timer);
        busy = false;
        syncBlocker();
        try {
          server.close();
        } catch {
          /* ignore */
        }
        for (const wc of rendererWindows()) {
          wc.executeJavaScript(
            `(window.__shuaqiiMain && delete window.__shuaqiiMain[${JSON.stringify(ID)}])`,
            false
          ).catch(() => {});
        }
      },
      get busy() {
        return busy;
      },
      get enabled() {
        return enabled();
      },
      get held() {
        return held();
      },
      get port() {
        return httpPort;
      },
      get token() {
        return token;
      },
    };

    tick().catch(() => {});
    console.log("[keep-awake] main half active (localhost bridge + powerSaveBlocker)");
  }

  // -------------------------------------------------------------------------
  // Renderer half: report enabled over the bridge, display main's state, and
  // fall back to a Web Wake Lock when the main half was not injected.
  // -------------------------------------------------------------------------
  function runRenderer() {
    (async () => {
      const sq = window.__sq;
      const overlay = window.__sqOverlay;
      const reg = window.__sqScripts;
      if (!sq || !overlay || !reg) {
        console.warn("[keep-awake] scripts/core.js must be injected first");
        return;
      }
      await sq.ready;

      const ID = "keep-awake";
      const POLL_MS = 1000;
      const REPORT_MS = 5000; // heartbeat cadence to the bridge
      const COLOR_ON = "#4ade80";
      const COLOR_OFF = "#737373";
      const COLOR_WARN = "#fbbf24";

      const supported = !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");

      const state = { id: null, busy: false, held: false, denied: false, main: null };
      const last = { text: null };

      let active = false;
      let unsubscribe = null;
      let lock = null;
      let pending = false;
      let lastReportAt = 0;

      // Status (incl. bridge port + token) published by the main half, or null.
      function mainStatus() {
        const box = window.__shuaqiiMain;
        return (box && box[ID]) || null;
      }

      function bridge() {
        const m = mainStatus();
        return m && typeof m.port === "number" ? m : null;
      }

      function bridgeUrl() {
        const m = bridge();
        return m ? `http://127.0.0.1:${m.port}/keep-awake` : null;
      }

      // Tell the main half whether the mod is enabled (heartbeat + immediate sends).
      function report(enabled, force) {
        const m = bridge();
        if (!m) return;
        const now = Date.now();
        if (!force && now - lastReportAt < REPORT_MS) return;
        lastReportAt = now;
        const body = JSON.stringify({ enabled: enabled, at: now, token: m.token });
        try {
          fetch(bridgeUrl(), {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: body,
            keepalive: true,
          }).catch(() => {});
        } catch {
          /* ignore */
        }
      }

      // Fire-and-forget so it still leaves during teardown.
      function reportDisabled() {
        const url = bridgeUrl();
        const m = bridge();
        if (!url || !m) return;
        const body = JSON.stringify({ enabled: false, at: Date.now(), token: m.token });
        try {
          if (navigator.sendBeacon) navigator.sendBeacon(url, body);
          else fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true }).catch(() => {});
        } catch {
          /* ignore */
        }
      }

      // Acquire the sentinel, unless one is already held, a request is in flight, the page
      // is hidden (the browser would reject/drop it), or we no longer want it.
      async function acquire() {
        if (!supported || !active || !state.busy || lock || pending) return;
        if (document.visibilityState !== "visible") return;
        pending = true;
        try {
          const sentinel = await navigator.wakeLock.request("screen");
          if (!active || !state.busy) {
            sentinel.release().catch(() => {});
            return;
          }
          lock = sentinel;
          state.held = true;
          state.denied = false;
          sentinel.addEventListener("release", () => {
            if (lock === sentinel) lock = null;
            state.held = false;
          });
        } catch (e) {
          state.denied = true;
          state.held = false;
          console.warn("[keep-awake] wake lock request failed:", e);
        } finally {
          pending = false;
        }
      }

      async function release() {
        state.held = false;
        if (!lock) return;
        const sentinel = lock;
        lock = null;
        try {
          await sentinel.release();
        } catch {
          /* ignore */
        }
      }

      // Hold while busy, release while idle. When the main half is running it owns the
      // wake block, so this never competes with it.
      function apply() {
        if (!active) return;
        if (state.main) {
          if (lock) release();
          return;
        }
        if (state.busy) acquire();
        else if (lock) release();
      }

      async function refresh() {
        const main = mainStatus();
        state.main = main;
        if (main) {
          state.busy = main.busy === true;
          return;
        }
        const id = sq.currentSessionId();
        if (id !== state.id) {
          state.id = id;
          state.busy = false;
        }
        if (!id) return;
        const busy = await sq.isSessionBusy(id, POLL_MS);
        if (id !== state.id || !active) return; // session switched or torn down while loading
        if (busy !== null) state.busy = busy;
      }

      function render() {
        if (!active) return;
        let text;
        let color;
        let title;
        const main = state.main;
        if (main) {
          if (main.held) {
            text = "awake \u00b7 held (main)";
            color = COLOR_ON;
            title = "the main process holds a powerSaveBlocker while the session runs";
          } else if (main.busy) {
            text = "awake \u00b7 main arming";
            color = COLOR_WARN;
            title = "session is busy; the main-process blocker is starting";
          } else {
            text = "awake \u00b7 idle";
            color = COLOR_OFF;
            title = "no busy session; the machine may sleep";
          }
        } else if (!state.id) {
          text = "awake \u00b7 no session";
          color = COLOR_OFF;
          title = "no active session";
        } else if (!state.busy) {
          text = "awake \u00b7 idle";
          color = COLOR_OFF;
          title = `${state.id} is idle`;
        } else if (!supported || state.denied) {
          text = "awake \u00b7 main off";
          color = COLOR_WARN;
          title = "no wake lock here or the main half isn't injected";
        } else if (state.held) {
          text = "awake \u00b7 held";
          color = COLOR_ON;
          title = `keeping the machine awake while ${state.id} runs`;
        } else if (document.visibilityState !== "visible") {
          text = "awake \u00b7 hidden";
          color = COLOR_WARN;
          title = "the window is hidden; the lock is re-taken when it is visible again";
        } else {
          text = "awake \u00b7 arming";
          color = COLOR_WARN;
          title = `acquiring a wake lock for ${state.id}`;
        }
        if (text === last.text) return; // nothing changed: no DOM write
        last.text = text;
        overlay.set(ID, text, { color, title });
      }

      async function tick() {
        if (!active) return;
        await refresh();
        if (!active) return;
        report(true, false);
        apply();
        render();
      }

      function onVisibility() {
        if (!active) return;
        apply();
        render();
      }

      function mount() {
        active = true;
        state.id = null;
        state.busy = false;
        state.held = false;
        state.denied = false;
        state.main = mainStatus();
        last.text = null;
        lastReportAt = 0;
        document.addEventListener("visibilitychange", onVisibility);
        unsubscribe = sq.every(POLL_MS, tick);
        report(true, true);
        tick().catch(() => {});
      }

      function unmount() {
        active = false;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        document.removeEventListener("visibilitychange", onVisibility);
        reportDisabled();
        release();
        overlay.remove(ID);
      }

      window.__sqKeepAwake = {
        dispose: unmount,
        tick,
        render,
        report,
        supported,
        get id() {
          return state.id;
        },
        get busy() {
          return state.busy;
        },
        get held() {
          return state.held;
        },
        get main() {
          return state.main;
        },
      };
      reg.register(ID, {
        label: "Keep Awake",
        version: "0.0.1",
        desc: "Keeps the machine awake while the session is running.",
        enabled: false,
        mount,
        unmount,
      });

      console.log("[keep-awake] renderer half active");
    })();
  }
})();
