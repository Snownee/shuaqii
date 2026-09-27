// Delayed message queue. While the mod is enabled, holding Alt when you send a
// message (Alt+Enter in the composer, or Alt+click the send button) intercepts it:
// the message is added to an in-memory queue and the composer is cleared, but nothing
// is sent. A normal send (no Alt) goes through untouched.
//
// The queue is bound to the session that produced its first message. While a
// different session is active, an Alt send is still intercepted but is not queued:
// the composer keeps its text and a center-right toast explains that the queue belongs
// to another session. Leaving that session with a non-empty queue pops a center-right
// toast warning that the queue only applies to its session page.
//
// While the queue is non-empty the overlay shows a "delayed queue(N)" line; clicking
// it opens a modal listing every queued message, each with a remove button, plus a
// button to clear the whole queue.
//
// The queue and its owning session are persisted to
// localStorage["shuaqii.queued-message"] so they survive renderer reloads and app
// restarts; the overlay line reappears on load while the queue is non-empty.
//
// When the queue's session transitions from running to idle, the oldest queued message
// is sent into it automatically (FIFO, at most one per stop). A message queued while the
// session is already idle waits for the next run to finish. "Running" is inferred from
// the session's own last message, so it works even while a different session page is open.
//
// If the session was interrupted by an error (not a manual stop), the queue is held:
// nothing is auto-sent until a run finishes normally.
//
// A message added while the session is still a new/draft session (which has no id yet,
// e.g. /new-session?draftId=...) is staged without a binding; it binds to the session
// once that session exists.
//
// Requires scripts/core.js to be injected first (window.__sq services including the
// shared __sq.toast notifier, the window.__sqOverlay panel, and the window.__sqScripts
// registry).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/queued-message.js
//
// How it intercepts (see the app bundle's PromptInputV2 component):
//   - Alt+Enter (no Shift, not composing) on the contenteditable editor
//   - Alt+click on the send button [data-action="prompt-submit"] (skipped while it is
//     the stop control, data-icon="stop")
// Listeners run on window in the capture phase, so they fire before Solid's delegated
// handlers on document and stopImmediatePropagation() keeps the app from sending.
// While the slash/@ suggestion popover is open (a .z-40.-translate-y-full sibling div)
// Alt+Enter is left alone, so selecting a suggestion still works.
// window.__sqQueuedMessage.debug keeps the last ~60 send decisions for troubleshooting.

(async () => {
  const sq = window.__sq;
  const overlay = window.__sqOverlay;
  const reg = window.__sqScripts;
  if (!sq || !overlay || !reg) {
    console.warn("[queued-message] scripts/core.js must be injected first");
    return;
  }

  const ID = "queued-message";
  const STYLE_ID = "sq-queued-message-style";
  const DIALOG_ID = "sq-queued-message-backdrop";
  const STORE_KEY = "shuaqii.queued-message";
  const EDITOR_SELECTOR = '[data-component="prompt-input"]';
  const FORM_SELECTOR = '[data-component="prompt-input-v2"]';
  const SUBMIT_SELECTOR = '[data-action="prompt-submit"]';
  const COLOR = "#4ade80";
  const TOAST_TEXT =
    "Queued Message: <br>You have left the session. Messages in the queue will not be sent automatically.";
  const CROSS_SESSION_TEXT =
    "Queued Message: <br>The queue belongs to another session; this message has not been added to the queue.";
  const TOAST_POSITION = "center-right";
  const FLUSH_POLL_MS = 1500;
  const FONT =
    "12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  // localStorage is the source of truth so the queue survives reloads; the previous
  // in-context instance is only a fallback when nothing was persisted.
  const prev = window.__sqQueuedMessage;
  const stored = readStore();
  const queue =
    stored && stored.queue.length
      ? stored.queue
      : Array.isArray(prev?.queue)
        ? prev.queue
        : [];
  let sessionId =
    stored && stored.queue.length
      ? stored.sessionId
      : typeof prev?.sessionId === "string"
        ? prev.sessionId
        : null;

  let active = false;
  let dialog = null;
  let node = null;
  let listHost = null;
  let titleEl = null;
  let clearBtn = null;
  let lastActive;
  let unsubscribe = null;
  let flushUnsubscribe = null;
  let flushing = false;
  let ownerRunning = null;
  const debug = [];
  const scriptToasts = new Set();

  // ---- persistence ----------------------------------------------------------
  function readStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return null;
      const list = Array.isArray(parsed.queue) ? parsed.queue : [];
      const clean = list
        .filter((m) => m && typeof m.text === "string")
        .map((m) => ({
          text: m.text,
          at: typeof m.at === "number" ? m.at : Date.now(),
        }));
      const sid =
        typeof parsed.sessionId === "string" ? parsed.sessionId : null;
      return { sessionId: sid, queue: clean };
    } catch {
      return null;
    }
  }

  function writeStore() {
    try {
      if (!queue.length) {
        localStorage.removeItem(STORE_KEY);
        return;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify({ sessionId, queue }));
    } catch {
      /* ignore */
    }
  }

  // ---- interception ---------------------------------------------------------
  function readComposerText() {
    const editor = document.querySelector(EDITOR_SELECTOR);
    if (!editor) return "";
    return (editor.innerText || editor.textContent || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function clearComposer() {
    const editor = document.querySelector(EDITOR_SELECTOR);
    if (!editor) return;
    editor.textContent = "";
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
  }

  // Scope to the composer: some parts of the app render hidden dropdowns with the same
  // translate classes, which must not make us think the suggestion popover is open.
  function isPopoverOpen() {
    const form = document.querySelector(FORM_SELECTOR);
    const root = (form && form.parentElement) || null;
    if (!root) return false;
    for (const el of root.querySelectorAll('div[class*="-translate-y-full"]')) {
      const cls = el.getAttribute("class") || "";
      if (!cls.includes("z-40")) continue;
      if (!el.getClientRects().length) continue; // hidden placeholder, not a real popover
      return true;
    }
    return false;
  }

  function submitButton(target) {
    return target instanceof Element ? target.closest(SUBMIT_SELECTOR) : null;
  }

  // Session helpers live in core.js (window.__sq) so every script shares one
  // implementation: currentSessionId is uncached, sessionBusy is page-independent, and
  // lastUserInfo feeds the agent/model passthrough.
  const currentSessionId = () => sq.currentSessionId();
  const lastUserInfo = (list) => sq.lastUserInfo(list);
  const lastAssistantBusy = (list) => sq.sessionBusy(list);

  function logDecision(stage, info) {
    try {
      debug.push(Object.assign({ t: Date.now(), stage }, info));
      if (debug.length > 60) debug.shift();
    } catch {
      /* ignore */
    }
  }

  // The session the queue is bound to, or null while the queue is empty or was started
  // in a new session that does not exist yet (a draft has no id): such a queue holds no
  // binding yet.
  function boundSession() {
    return queue.length ? sessionId : null;
  }

  // Adding is allowed in the bound session. An unbound queue (new/draft session, or no
  // active session) accepts messages so they can be staged until a session exists.
  function canQueue() {
    const bound = boundSession();
    if (!bound) return true;
    return currentSessionId() === bound;
  }

  // The queue belongs to another session than the one currently active.
  function isCrossSession() {
    const current = currentSessionId();
    const bound = boundSession();
    return !!bound && !!current && current !== bound;
  }

  function interceptAndQueue(event, text) {
    event.preventDefault();
    event.stopImmediatePropagation();
    enqueue(text);
    clearComposer();
  }

  // Intercept but keep the composer text: the message cannot join another session's
  // queue, so the send is held back and the user is told why.
  function interceptCrossSession(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showToast(CROSS_SESSION_TEXT);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter") return;
    const target = event.target instanceof Element ? event.target : null;
    const text = readComposerText();
    const info = {
      alt: event.altKey,
      shift: event.shiftKey,
      composing: event.isComposing,
      keyCode: event.keyCode,
      repeat: event.repeat,
      inEditor: !!(target && target.closest(EDITOR_SELECTOR)),
      active,
      dialog: !!dialog,
      popover: isPopoverOpen(),
      current: currentSessionId(),
      sessionId,
      cross: isCrossSession(),
      can: canQueue(),
      textLen: text.length,
    };
    if (!active || dialog) return;
    if (!event.altKey) {
      logDecision("keydown-plain", info);
      return;
    }
    if (
      !info.inEditor ||
      event.shiftKey ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat
    ) {
      logDecision("keydown-skip", info);
      return;
    }
    if (info.popover) {
      logDecision("keydown-popover", info);
      return;
    }
    if (!text) {
      logDecision("keydown-empty", info);
      return;
    }
    if (info.cross) {
      logDecision("keydown-cross", info);
      return interceptCrossSession(event);
    }
    if (!info.can) {
      logDecision("keydown-nosession", info);
      return;
    }
    logDecision("keydown-queue", info);
    interceptAndQueue(event, text);
  }

  function onClick(event) {
    const btn = submitButton(event.target);
    if (!btn) return;
    const text = readComposerText();
    const info = {
      alt: event.altKey,
      active,
      dialog: !!dialog,
      icon: btn.getAttribute("data-icon"),
      current: currentSessionId(),
      sessionId,
      cross: isCrossSession(),
      can: canQueue(),
      textLen: text.length,
    };
    if (!active || dialog) return;
    if (!event.altKey) {
      logDecision("click-plain", info);
      return;
    }
    if (info.icon === "stop") {
      logDecision("click-stop", info);
      return;
    }
    if (!text) {
      logDecision("click-empty", info);
      return;
    }
    if (info.cross) {
      logDecision("click-cross", info);
      return interceptCrossSession(event);
    }
    if (!info.can) {
      logDecision("click-nosession", info);
      return;
    }
    logDecision("click-queue", info);
    interceptAndQueue(event, text);
  }

  // ---- queue + overlay ------------------------------------------------------
  function enqueue(text) {
    const current = currentSessionId();
    const bound = boundSession();
    if (bound && current !== bound) return false; // forbid cross-session adds
    if (!bound && current) sessionId = current; // bind once a session exists
    // A fresh message must wait for the session to run and stop again: forget any
    // previously observed state when the queue was empty.
    if (queue.length === 0) ownerRunning = null;
    queue.push({ text, at: Date.now() });
    writeStore();
    render();
    return true;
  }

  function removeAt(index) {
    if (index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    if (!queue.length) sessionId = null;
    writeStore();
    render();
    renderDialog();
  }

  function clearAll() {
    queue.length = 0;
    sessionId = null;
    writeStore();
    render();
    renderDialog();
  }

  function render() {
    if (!active) return;
    if (!queue.length) {
      overlay.remove(ID);
      return;
    }
    if (!node) {
      node = document.createElement("span");
      node.style.pointerEvents = "auto";
      node.style.cursor = "pointer";
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openDialog();
      });
    }
    node.textContent = `delayed queue(${queue.length})`;
    overlay.setNode(ID, node, {
      color: COLOR,
      interactive: true,
      title: "click to view the delayed messages",
    });
  }

  // ---- toasts ---------------------------------------------------------------
  // The toast UI lives in core.js (window.__sq.toast); this script only supplies its
  // text and a position lower than the default.
  function showToast(text) {
    if (typeof sq.toast !== "function") return null;
    const el = sq.toast(text, {
      html: true,
      position: TOAST_POSITION,
      title: "Queued Message",
    });
    if (el) scriptToasts.add(el);
    return el;
  }

  // ---- session watch --------------------------------------------------------
  function tick() {
    if (!active) return;
    const current = currentSessionId();
    if (lastActive === undefined) {
      lastActive = current;
      return;
    }
    if (lastActive === current) return;
    const previous = lastActive;
    lastActive = current;
    // Left the queue's session while it still holds messages.
    if (
      sessionId &&
      queue.length &&
      previous === sessionId &&
      current !== sessionId
    ) {
      showToast(TOAST_TEXT);
    }
  }

  // ---- auto flush -----------------------------------------------------------
  // While the queue's session is NOT running, its oldest queued message is sent back
  // into it (at most one per idle spell: the next is held until the session runs and
  // stops again). "Running" is inferred from the session's own last message, so it works
  // even when a different session is open. See the readme note on alternatives.
  // A session that stopped because of an error (not a manual stop): its last assistant
  // message carries info.error, or a "Bad Request" text (mirrors auto-retry). While such
  // a tail is in place the queue is held, so a broken run is not auto-fed another message.
  function sessionErrored(list) {
    if (!Array.isArray(list) || !list.length) return false;
    const last = list[list.length - 1];
    const info = (last && last.info) || {};
    if (info.role !== "assistant") return false;
    if (info.error) return info.error.name !== "MessageAbortedError";
    const texts = (last.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text || "");
    return texts.some((t) => /bad request/i.test(t));
  }

  async function sendQueued(id, text) {
    const body = { parts: [{ type: "text", text }] };
    const info = lastUserInfo(await sq.messages(id, 0));
    if (info) {
      if (info.agent) body.agent = info.agent;
      if (info.model) body.model = info.model;
    }
    const res = await fetch(
      `${sq.server.url}/session/${encodeURIComponent(id)}/prompt_async`,
      {
        method: "POST",
        headers: { Authorization: sq.auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return res.status;
  }

  async function flushTick() {
    if (!active || !queue.length || flushing || !sq.server || !sq.auth) return;
    if (!sessionId) {
      const current = currentSessionId();
      if (!current) return; // staged in a new session with no id yet: nothing to send to
      sessionId = current; // the session now exists: bind the staged queue to it
      writeStore();
      render();
    }
    const id = sessionId;
    flushing = true;
    try {
      const list = await sq.messages(id, FLUSH_POLL_MS);
      if (!list) return; // cannot tell: don't send
      const busy = sq.sessionBusy(list);
      const wasRunning = ownerRunning;
      ownerRunning = busy;
      if (busy) return; // still running: wait for it to stop
      // Only flush on a running -> idle transition. A message queued while the session
      // was already idle (wasRunning !== true) waits for the next run to finish.
      if (wasRunning !== true) return;
      if (sessionErrored(list)) {
        // It stopped because of an error: hold the queue until a run finishes normally
        // (a manual stop/abort does not count as an error).
        logDecision("flush-held-error", { sid: id, remaining: queue.length });
        return;
      }
      const msg = queue[0];
      let code = 0;
      try {
        code = await sendQueued(id, msg.text);
      } catch {
        code = 0;
      }
      if (code >= 200 && code < 300) {
        queue.shift();
        if (!queue.length) sessionId = null; // empty queue drops its session binding
        writeStore();
        render();
        logDecision("flush-sent", { sid: id, code, remaining: queue.length });
      } else {
        logDecision("flush-failed", { sid: id, code });
      }
    } finally {
      flushing = false;
    }
  }

  // ---- dialog ---------------------------------------------------------------
  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
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
        font: ${FONT};
        pointer-events: auto;
      }
      #${DIALOG_ID} .qm-panel {
        display: flex;
        flex-direction: column;
        min-width: 320px;
        max-width: 70vw;
        max-height: 70vh;
        background: rgba(17, 17, 17, 0.97);
        color: #e5e5e5;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
        padding: 12px 14px;
        outline: none;
      }
      #${DIALOG_ID} .qm-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        color: ${COLOR};
      }
      #${DIALOG_ID} .qm-close {
        background: none;
        border: 0;
        color: #e5e5e5;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
      }
      #${DIALOG_ID} .qm-close:hover { color: #f87171; }
      #${DIALOG_ID} .qm-list {
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 50vh;
      }
      #${DIALOG_ID} .qm-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        padding: 6px 8px;
      }
      #${DIALOG_ID} .qm-item-main { flex: 1; min-width: 0; }
      #${DIALOG_ID} .qm-item-index {
        color: #737373;
        margin-bottom: 2px;
      }
      #${DIALOG_ID} .qm-item-text {
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${DIALOG_ID} .qm-item-del {
        flex: none;
        background: none;
        border: 0;
        color: #a3a3a3;
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      #${DIALOG_ID} .qm-item-del:hover { color: #f87171; }
      #${DIALOG_ID} .qm-empty { color: #737373; }
      #${DIALOG_ID} .qm-actions {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 12px;
      }
      #${DIALOG_ID} .qm-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 10px;
      }
      #${DIALOG_ID} .qm-btn:hover { background: rgba(255, 255, 255, 0.16); }
      #${DIALOG_ID} .qm-btn.qm-clear {
        color: #f87171;
        border-color: rgba(248, 113, 113, 0.5);
      }
      #${DIALOG_ID} .qm-btn.qm-clear:hover { background: rgba(248, 113, 113, 0.18); }
      #${DIALOG_ID} .qm-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      #${DIALOG_ID} .qm-btn:disabled:hover { background: rgba(255, 255, 255, 0.08); }
    `;
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    window.removeEventListener("keydown", onDialogKey, true);
  }

  function onDialogKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDialog();
    }
  }

  function renderDialog() {
    if (!dialog) return;
    titleEl.textContent = `Delayed Queue (${queue.length})`;
    clearBtn.disabled = !queue.length;

    if (!queue.length) {
      const empty = document.createElement("div");
      empty.className = "qm-empty";
      empty.textContent = "the queue is empty";
      listHost.replaceChildren(empty);
      return;
    }

    listHost.replaceChildren(
      ...queue.map((item, i) => {
        const row = document.createElement("div");
        row.className = "qm-item";

        const main = document.createElement("div");
        main.className = "qm-item-main";
        const index = document.createElement("div");
        index.className = "qm-item-index";
        index.textContent = `#${i + 1}`;
        const text = document.createElement("div");
        text.className = "qm-item-text";
        text.textContent = item.text;
        main.append(index, text);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "qm-item-del";
        del.textContent = "\u00d7";
        del.title = "remove this message";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          removeAt(i);
        });

        row.append(main, del);
        return row;
      }),
    );
  }

  function openDialog() {
    if (!active || dialog) return;
    ensureStyle();

    const backdrop = document.createElement("div");
    backdrop.id = DIALOG_ID;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog();
    });

    const panel = document.createElement("div");
    panel.className = "qm-panel";
    panel.tabIndex = -1;
    panel.addEventListener("click", (event) => event.stopPropagation());

    const head = document.createElement("div");
    head.className = "qm-head";
    titleEl = document.createElement("span");
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "qm-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "close";
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeDialog();
    });
    head.append(titleEl, closeBtn);
    panel.appendChild(head);

    listHost = document.createElement("div");
    listHost.className = "qm-list";
    panel.appendChild(listHost);

    const actions = document.createElement("div");
    actions.className = "qm-actions";
    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "qm-btn qm-clear";
    clearBtn.textContent = "Clear";
    clearBtn.title = "remove every queued message";
    clearBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      clearAll();
    });
    const done = document.createElement("button");
    done.type = "button";
    done.className = "qm-btn";
    done.textContent = "Close";
    done.addEventListener("click", closeDialog);
    actions.append(clearBtn, done);
    panel.appendChild(actions);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    window.addEventListener("keydown", onDialogKey, true);
    panel.focus();
    dialog = backdrop;
    renderDialog();
  }

  // ---- lifecycle ------------------------------------------------------------
  function mount() {
    active = true;
    ensureStyle();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    lastActive = currentSessionId();
    flushing = false;
    ownerRunning = null;
    unsubscribe = sq.every(500, tick);
    flushUnsubscribe = sq.every(FLUSH_POLL_MS, flushTick);
    render();
    flushTick();
  }

  function unmount() {
    active = false;
    closeDialog();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (flushUnsubscribe) {
      flushUnsubscribe();
      flushUnsubscribe = null;
    }
    flushing = false;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
    overlay.remove(ID);
    for (const el of scriptToasts) sq.toast.dismiss(el);
    scriptToasts.clear();
    document.getElementById(STYLE_ID)?.remove();
  }

  window.__sqQueuedMessage = {
    dispose: unmount,
    queue,
    readComposerText,
    isPopoverOpen,
    canQueue,
    isCrossSession,
    currentSessionId,
    debug,
    enqueue,
    removeAt,
    clearAll,
    render,
    showToast,
    tick,
    flushTick,
    sessionErrored,
    lastAssistantBusy,
    lastUserInfo,
    sendQueued,
    openDialog,
    closeDialog,
    get sessionId() {
      return sessionId;
    },
    get ownerRunning() {
      return ownerRunning;
    },
    get active() {
      return active;
    },
  };
  reg.register(ID, {
    label: "Queued Message",
    version: "0.0.1",
    desc: "Alt+Enter to queue a message for later sending.",
    mount,
    unmount,
  });

  console.log("[queued-message] registered");
})();
