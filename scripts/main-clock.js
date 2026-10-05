// Drives the shared mod ticker (window.__sq) from the Electron main process.
//
//   python shuaqii.py --launch --restart
//
// Renderer timers are throttled while the window is hidden — setInterval drops to ~1/s
// (and ~1/min after a while) and requestAnimationFrame pauses — so every subscriber of
// __sq.every (session-timer, retry, queued-message, …) would stall in the background.
// The main process timer is never throttled, so its half calls __sq.tick() in each renderer
// on a fixed cadence and the renderer half flips core.js over via __sq.setMainClock(true)
// (which stops the local fallback interval). Delete this file and core.js falls back to the
// old local timer automatically.
//
// It is infrastructure, so it registers as a locked (always-on) mod.
//
// The "@shuaqii:main" marker makes shuaqii inject this file into the main process too.
// @shuaqii:main

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") {
    runMain();
  } else {
    runRenderer();
  }

  // -------------------------------------------------------------------------
  // Main-process half: the clock.
  // -------------------------------------------------------------------------
  function runMain() {
    const electron =
      (typeof require === "function" && require("electron")) ||
      (process.mainModule && process.mainModule.require("electron"));
    if (!electron || !electron.webContents) {
      console.warn("[main-clock] not running under Electron; skipping main half");
      return;
    }

    const { webContents } = electron;
    const ID = "main-clock";
    const TICK_MS = 250;
    const RENDERER_PREFIX = "oc://renderer";
    const DRIVE = "window.__sq && window.__sq.tick && window.__sq.tick();";

    const root = (globalThis.__shuaqiiMain = globalThis.__shuaqiiMain || {});
    const pass = globalThis.__shuaqii && globalThis.__shuaqii.pass;
    if (root[ID] && typeof root[ID].dispose === "function") {
      try {
        root[ID].dispose();
      } catch {
        /* ignore */
      }
    }

    let driving = false;
    async function drive() {
      if (driving) return; // a slow renderer must not stack ticks
      driving = true;
      try {
        for (const wc of webContents.getAllWebContents()) {
          if (wc.isDestroyed()) continue;
          if (!(wc.getURL() || "").startsWith(RENDERER_PREFIX)) continue;
          try {
            await wc.executeJavaScript(DRIVE, false);
          } catch {
            /* renderer mid-reload: skip this tick */
          }
        }
      } finally {
        driving = false;
      }
    }

    const timer = setInterval(() => {
      drive().catch(() => {});
    }, TICK_MS);

    root[ID] = {
      id: ID,
      pass: pass,
      drive,
      tick: drive,
      dispose() {
        clearInterval(timer);
      },
    };

    console.log(`[main-clock] main half active (ticking renderers every ${TICK_MS}ms)`);
  }

  // -------------------------------------------------------------------------
  // Renderer half: hand the clock over to the main process.
  // -------------------------------------------------------------------------
  function runRenderer() {
    (async () => {
      const sq = window.__sq;
      const reg = window.__sqScripts;
      if (!sq || !reg) {
        console.warn("[main-clock] scripts/core.js must be injected first");
        return;
      }
      await sq.ready;

      const ID = "main-clock";

      function mount() {
        if (sq.setMainClock) sq.setMainClock(true);
      }

      function unmount() {
        if (sq.setMainClock) sq.setMainClock(false);
      }

      reg.register(ID, {
        label: "Main Clock",
        version: "0.0.1",
        desc: "Runs the shared ticker from the main process so it keeps ticking while hidden.",
        locked: true,
        mount,
        unmount,
      });

      console.log("[main-clock] renderer half active");
    })();
  }
})();
