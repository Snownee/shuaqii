// Ports the multiline-paste fix from opencode PR #45497 ("prevent renderer OOM on
// multiline paste") without patching the app: it pre-empts the composer's own paste
// handler before that handler can run.
//
// Why: the composer editor's `paste` handler calls
// `document.execCommand("insertText", false, text)` for every paste. Chromium emits one
// `input` event per line for a multiline `insertText`, so a large paste (e.g. a 6,000-line
// crash report) reparses and re-serializes the draft thousands of times and can OOM the
// renderer. The fix inserts multiline text once with `insertHTML` (escaped, so pasted
// markup stays literal) after normalizing CRLF/CR to LF; single-line pastes and the
// existing fallback are left unchanged.
//
// How it intercepts (see the app bundle's composer controller): the handler is bound
// directly to the editor element [data-component="prompt-input"] via
// `addEventListener(el, "paste", controller.onPaste)`. A capture-phase listener on window
// runs first, so preventDefault() + stopImmediatePropagation() stops it. Only pastes whose
// target is inside the composer editor are touched; file / empty pastes fall through to the
// app's attachment path, and single-line pastes fall through to the app's insertText path.
// Mirrors scripts/queued-message.js's window-capture interception technique.
//
// Requires scripts/core.js to be injected first.
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/paste-fix.js
//
// Silent by design: it draws no overlay line. It still appears in the mod list (which is
// how you turn it on/off). window.__sqPasteFix.debug keeps the last ~40 paste decisions
// for troubleshooting.

(async () => {
  const sq = window.__sq;
  const reg = window.__sqScripts;
  if (!sq || !reg) {
    console.warn("[paste-fix] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "paste-fix";
  const EDITOR_SELECTOR = '[data-component="prompt-input"]';

  const stats = { pastes: 0, lines: 0, lastAt: 0 };
  const debug = [];
  let active = false;

  function log(stage, info) {
    try {
      debug.push(Object.assign({ t: Date.now(), stage }, info));
      if (debug.length > 40) debug.shift();
    } catch {
      /* ignore */
    }
  }

  // Escaped plain text: the pasted content must stay literal, never markup.
  function escapeHTML(text) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  // Mirrors the app's own fallback (interaction.ts): a plain text node at the caret plus a
  // single input event, used only when execCommand("insertHTML") is unavailable/fails.
  function fallbackInsert(editor, text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
    return true;
  }

  function onPaste(event) {
    if (!active) return;
    const target = event.target instanceof Element ? event.target : null;
    const editor = target && target.closest(EDITOR_SELECTOR);
    if (!editor) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // File paste (or mixed): leave it to the app's attachments.handlePaste.
    if (Array.from(clipboard.items || []).some((item) => item.kind === "file")) return;
    const raw = clipboard.getData("text/plain");
    if (!raw) return; // no plain text: leave it to the app's attachment path
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text.includes("\n")) return; // single-line: leave the app's insertText path alone

    // Multiline: take over so the app inserts it once instead of line by line.
    event.preventDefault();
    event.stopImmediatePropagation();

    let ok = false;
    if (typeof document.execCommand === "function") {
      try {
        ok = document.execCommand("insertHTML", false, escapeHTML(text));
      } catch {
        ok = false;
      }
    }
    if (!ok) fallbackInsert(editor, text);

    stats.pastes += 1;
    stats.lines = text.split("\n").length;
    stats.lastAt = Date.now();
    log("paste", { lines: stats.lines, chars: text.length, exec: ok });
  }

  function mount() {
    active = true;
    window.addEventListener("paste", onPaste, true);
  }

  function unmount() {
    active = false;
    window.removeEventListener("paste", onPaste, true);
  }

  window.__sqPasteFix = {
    dispose: unmount,
    escapeHTML,
    fallbackInsert,
    stats,
    debug,
    onPaste,
    get active() {
      return active;
    },
  };
  reg.register(ID, {
    label: "Paste Fix",
    version: "0.0.1",
    desc: "Insert multiline pastes once (opencode PR #45497) to avoid renderer OOM.",
    mount,
    unmount,
  });

  console.log("[paste-fix] registered");
})();
