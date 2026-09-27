---
name: inject-script
description: Use when adding or editing an OpenCode Desktop injection script for this repo's CDP toolchain (shuaqii.py + scripts/core.js) — registering overlay lines, reading session/message state from the bundled server, detecting running/idle, or sending messages. Triggers: "new inject script", "新增脚本", "写个脚本注入", "overlay", "session-timer", "auto-retry", "shuaqii".
---

# Writing an injection script for `shuaqii`

This repo injects JavaScript into the **running OpenCode Desktop renderer** over the
Chrome DevTools Protocol.

- `shuaqii.py` — the injector: `--list`, `-s <file>`, `-e <code>`, `-i` (interactive),
  `--live` (hot reload on save), `--launch [EXE]` / `--restart`.
- `scripts/core.js` — owns the shared bottom-right panel (`window.__sqOverlay`), the
  shared services (`window.__sq`: server/auth, active session, running detection,
  message loading, one ticker), **and the script registry (`window.__sqScripts`)**.
  A feature script registers with it instead of self-managing, subscribes to `__sq`
  instead of re-initializing, and usually pushes a line into the panel rather than
  drawing its own UI.
- `scripts/mod-list.js` — renders the registry: clicking the overlay's
  `shuaqii <version>` title opens a modal where the user enables/disables scripts.
- `scripts/session-timer.js`, `scripts/auto-retry.js`, `scripts/message-jump.js`,
  `scripts/theme-diy.js`, `scripts/queued-message.js` — reference implementations to
  copy from.

Scripts run inside the renderer, whose URL is `oc://renderer/index.html`.

## Workflow

1. Create `scripts/<name>.js`.
2. Inject **`scripts/core.js` first**, then your script (CLI order is preserved):
   ```powershell
   python shuaqii.py --live -s scripts/core.js -s scripts/<name>.js
   ```
   (Auto-load mode — no `-s`/`-e` — loads every `scripts/*.js` with `core.js` first, so
   dropping the file in `scripts/` is enough.)
3. Verify against the live app (see "Verifying" below). Re-inject (or save, with
   `--live`) after each edit.

## Overlay API (register a line)

`scripts/core.js` exposes `window.__sqOverlay`:

```js
window.__sqOverlay.set(id, text, { color, title });       // plain text line
window.__sqOverlay.setNode(id, domNode, { interactive }); // custom DOM (checkbox, button…)
window.__sqOverlay.remove(id);
```

- Items are keyed by `id` → re-injecting **replaces** the same line, never duplicates.
- Lines are stacked bottom-right in registration order.
- Items are `pointer-events: none` by default. Pass `{ interactive: true }` to make a
  line clickable (required for checkboxes/buttons).

## Script registry (register yourself)

Feature scripts don't manage their own lifetime. They `register()` with
`scripts/core.js`, which owns the enabled/disabled state (persisted to
`localStorage["shuaqii.mods"]` as `{ "<id>": { "enabled": false } }`) and calls your
lifecycle hooks. `scripts/mod-list.js` lists every registered script behind the
overlay's `shuaqii <version>` title, where the user toggles them on/off.

```js
window.__sqScripts.register(id, {
  label,            // required: human-readable name shown in the list
  version,          // optional: shown next to the label in mod-list
  order,            // optional sort key (default 100; ties keep registration order)
  locked,           // optional: hide the toggle (reserved for mod-list itself)
  enabled,          // optional: default on first load (absent = true)
  actions,          // optional row buttons: [{ label, title?, onClick, color? }]
  mount,            // required: build UI / subscribe / start work
  unmount,          // required: tear everything down (must be idempotent)
});
```

- `enabled` is only the **first-load** default. Once the user toggles the script in
  mod-list, the persisted choice overrides it (so changing the default later won't
  re-enable a script the user turned off).

- `register` is itself idempotent: on re-injection it calls the previous instance's
  `unmount()` first, so you **don't** call `dispose()` at the top of your file.
- Registry helpers: `enabled(id)`, `setEnabled(id, bool)`, `onChange(fn)` (returns an
  unsubscribe), `list()`, `unregister(id)`.
- Plugins can add a row button later: `__sqScripts.addAction(id, { label, onClick })`.

## Script skeleton (idempotent, hot-reload safe)

```js
(async () => {
  const sq = window.__sq;
  const reg = window.__sqScripts;            // registry, owned by core.js
  if (!sq || !reg) {
    console.warn("[my-feature] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;                            // server/auth/windowID resolved

  const ID = "my-feature";
  const state = { value: 0 };
  let active = false;
  let unsubscribe = null;

  function render() {
    if (!active) return;                     // a late tick() must not resurrect UI
    window.__sqOverlay.set(ID, `my-feature ${state.value}`, { title: "..." });
  }

  async function tick() {
    if (!active) return;
    /* ... update state ... */
    render();
  }

  // core calls these as the user enables/disables you (and around re-injection).
  function mount() {
    active = true;
    unsubscribe = sq.every(1000, tick);      // shared ticker — don't add setInterval
    tick().catch(() => {});
  }

  function unmount() {
    active = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    window.__sqOverlay.remove(ID);
  }

  window.__sqMyFeature = { dispose: unmount, tick, render };  // optional debug handle
  reg.register(ID, { label: "My Feature", mount, unmount });
})();
```

Notes:
- Keep `mount`/`unmount` symmetric and safe to call repeatedly; guard async work with
  the `active` flag so a `tick()` that resolves after `unmount()` touches nothing.
- Top-level `await` only works inside an `async IIFE` — `Runtime.evaluate` rejects bare
  top-level `await`.
- Keep it **zero-dependency**; it runs in the renderer's page context.

## Renderer APIs you can rely on

`scripts/core.js` resolves these once and exposes them as `window.__sq`; feature scripts
should use that instead of calling `window.api` themselves:

- `await __sq.ready` — resolves once `server` / `auth` / `windowID` are set
- `__sq.activeSessionId()` — active session id (short-cached), or `null`
- `__sq.isRunning()` — the composer shows the stop icon
- `__sq.messages(id, maxAge?)` — session message list (`{ info, parts }[]`, or `null` on
  failure); short-TTL cache + in-flight dedup shared by every script
- `__sq.every(ms, fn)` — subscribe to the one shared ticker; returns an unsubscribe fn

The raw APIs those helpers wrap (rarely needed directly):

```js
const server = await window.api.awaitInitialization(); // { url, username, password }
const auth = "Basic " + btoa(`${server.username}:${server.password}`);

const windowID = await window.api.getWindowID(); // ⚠ returns a Promise — await it
```

- **Active session id** — from the app's own routing state:
  ```js
  const value = localStorage.getItem(`opencode.desktop.window.${windowID}.last-active-url`); // "/server/xxx/session/ses_…"
  const id = value && value.match(/session\/([^/?#]+)/)?.[1];
  ```
  Fallback: scan every `localStorage` key ending in `.last-active-url`.
- **Running vs idle** — read the composer submit button (locale-independent):
  ```js
  const running = document.querySelector('[data-action="prompt-submit"]')?.getAttribute("data-icon") === "stop";
  ```
- **Messages** — `GET {url}/session/{id}/message` → array of `{ info, parts }` (reach it via
  `__sq.messages(id)`, which caches). Useful fields:
  - `info.role` (`"user"` | `"assistant"`), `info.time.created`, `info.time.completed`
  - `info.error` = `{ name, data: { message, statusCode, ... } }` — `name === "MessageAbortedError"`
    is a **manual stop**; anything else (e.g. `"APIError"` with `"Bad Request: …"`) is an
    **abnormal abort**
  - `info.agent`, `info.model` (pass these through when sending)
  - `parts[].type`: `text` / `reasoning` / `tool` / `step-start` / `step-finish`; tool parts
    carry `state.status`
- **Send a message** (fire-and-forget, returns `204`):
  ```js
  await fetch(`${server.url}/session/${encodeURIComponent(id)}/prompt_async`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "continue" }], agent, model }),
  });
  ```

All requests need the `Authorization` header; the sidecar uses HTTP Basic with a random
password regenerated every launch.

## Verifying against the live app

```powershell
python shuaqii.py --list                    # list targets ("*" = injectable)
python shuaqii.py -e "…js…"                 # one-shot, no return value
@('0','…js…') | python shuaqii.py -i -t 8   # interactive, prints evaluated values
```

- Prefer `-i` to read values back (`-e` only logs injection success).
- **Shell gotcha (PowerShell piping):** when `$OutputEncoding` emits a BOM (e.g. you set
  it to `[System.Text.UTF8Encoding]::new($true)`), the *first* piped line is prefixed
  with a BOM and fails (`ReferenceError: ﻿window is not defined`). Prepend a dummy line
  like `'0'` to absorb it. The default `us-ascii` encoding does not add a BOM, so a
  dummy line is only needed once you've changed `$OutputEncoding`.
- Probe the live app's real shapes before hard-coding selectors or field names — they can
  change between OpenCode versions. Inspect `app.asar` (`resources/app.asar`, read as
  bytes and search for strings) when unsure of an endpoint or error schema.

## Environment facts / footguns

- OpenCode Desktop uses an Electron **single-instance lock** and hardcodes
  `app.setPath("userData", …)`, so `--user-data-dir` / `--isolated` are ignored. The only
  way to attach is to launch it with `--remote-debugging-port=<n>` while **no other
  instance is running**.
- If you are running *inside* OpenCode Desktop, never `taskkill` it — you kill your own
  host/session. Run `python shuaqii.py --launch --restart` from an external terminal.
- The injector skips `devtools://`, `chrome://`, `chrome-extension://`,
  `chrome-untrusted://`, `edge://`, and `about:` targets.
- Reloading the renderer (Ctrl+F5, the app's "Reload" menu item, `location.reload()`)
  wipes the page context. A **watching** injector (auto-load, `--live`, `--watch`, `-i`)
  detects the missing liveness marker and re-injects automatically; a one-shot run
  (plain `-s`/`-e`, no watch) exits and must be re-run.
