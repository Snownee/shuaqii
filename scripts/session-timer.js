// Bottom-right line showing how long the current session has been running.
// Requires scripts/core.js to be injected first (window.__sq shared services and
// the window.__sqScripts registry it registers itself with).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/session-timer.js
//
// "Running" is derived from the session's own messages (via __sq.sessionBusy: a trailing
// user turn, or an assistant message with no time.completed) instead of the composer's
// stop icon, so it stays correct even if the composer is not the focused view. The
// elapsed time is measured from your most recent user message; while the session is idle
// it shows "--:--".

(async () => {
  const sq = window.__sq;
  const overlay = window.__sqOverlay;
  const reg = window.__sqScripts;
  if (!sq || !overlay || !reg) {
    console.warn("[session-timer] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "session-timer";
  const POLL_MS = 1000;

  const pad = (n) => String(n).padStart(2, "0");
  const format = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  // created ms of the latest user message, or null
  function lastUserTime(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const info = (list[i] && list[i].info) || {};
      if (info.role === "user" && info.time && info.time.created)
        return info.time.created;
    }
    return null;
  }

  const state = { id: null, since: null, running: false };
  const last = { text: null, title: null };

  let active = false;
  let unsubscribe = null;

  async function refresh() {
    const id = sq.currentSessionId();
    if (id !== state.id) {
      state.id = id;
      state.since = null;
      state.running = false;
    }
    if (!id) return;

    const list = await sq.messages(id, POLL_MS);
    if (id !== state.id || !list) return; // session switched while loading
    const busy = sq.sessionBusy(list);
    state.running = busy;
    state.since = busy ? lastUserTime(list) : null;
  }

  function render() {
    if (!active) return;
    let text;
    let title;
    if (!state.id) {
      text = "--:--";
      title = "no active session";
    } else if (!state.running) {
      text = "--:--";
      title = "session is idle";
    } else if (!state.since) {
      text = "--:--";
      title = "session is running";
    } else {
      text = `${format(Date.now() - state.since)}`;
      title = "running since your last message";
    }
    if (text === last.text && title === last.title) return; // nothing changed: no DOM write
    last.text = text;
    last.title = title;
    overlay.set(ID, text, { title });
  }

  async function tick() {
    if (!active) return;
    await refresh();
    render();
  }

  function mount() {
    active = true;
    state.id = null;
    state.since = null;
    state.running = false;
    last.text = null;
    last.title = null;
    unsubscribe = sq.every(POLL_MS, tick);
    tick().catch(() => {});
  }

  function unmount() {
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    overlay.remove(ID);
  }

  window.__sqSessionTimer = {
    dispose: unmount,
    refresh,
    render,
    lastUserTime,
    get id() {
      return state.id;
    },
    get since() {
      return state.since;
    },
    get running() {
      return state.running;
    },
    debug: {
      get state() {
        return state;
      },
      refresh,
      lastUserTime,
    },
  };
  reg.register(ID, {
    label: "Session Timer",
    version: "0.0.1",
    desc: "Elapsed time since your last message.",
    mount,
    unmount,
  });

  console.log("[session-timer] registered");
})();
