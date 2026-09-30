// Adds up/down arrow buttons on the right edge of the session message area, to jump
// to the previous / next message you sent in the current session. The down button
// stays live past your last message and jumps to the very bottom of the session; it
// only greys out once the view is already at the bottom.
// Requires scripts/core.js to be injected first (window.__sq shared services).
//
//   python shuaqii.py --live -s scripts/core.js -s scripts/message-jump.js
//
// Notes:
// - The message list is virtualized, so only rows near the viewport exist in the DOM.
//   The adjacent message is identified with the bundled server's user-message order;
//   when it is not rendered yet we page toward it, then center it by id (re-measuring
//   until it stops moving, since virtualization remeasures rows as they mount).
// - While a response streams the app pins the view to the bottom; a synthesized wheel
//   event tells it to stop following so the jump sticks.

(async () => {
  const sq = window.__sq;
  const reg = window.__sqScripts;
  if (!sq || !reg) {
    console.warn("[message-jump] scripts/core.js must be injected first");
    return;
  }
  await sq.ready;

  const ID = "message-jump";
  const XPATH = '//*[@id="root"]/div[1]/main/div/div/div/div/div[1]/div/div[2]';
  const HOST_ID = "oc-msg-jump";
  const USER_ROW = '[data-timeline-row="UserMessage"]';

  const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  // wait for a paint, but never hang: rAF is throttled when the window is occluded/busy
  const settle = async (n = 2) => {
    for (let i = 0; i < n; i++) await Promise.race([raf(), sleep(80)]);
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ordered ids of the user messages in a session (for prev/next bounds)
  let idsSession = null;
  let userIds = null;
  let idsAt = 0;
  async function refreshUserIds(id) {
    if (!id) return;
    if (id === idsSession && userIds && Date.now() - idsAt < 5000) return;
    const list = await sq.messages(id, 5000);
    if (!list) return;
    userIds = list
      .map((m) => m.info || {})
      .filter((info) => info.role === "user" && info.id)
      .map((info) => info.id);
    idsSession = id;
    idsAt = Date.now();
  }

  function findContainer() {
    try {
      const node = document.evaluate(XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (node) return node;
    } catch {
      /* ignore */
    }
    for (const vp of document.querySelectorAll(".scroll-view__viewport")) {
      if (vp.querySelector("[data-timeline-row]")) return vp.closest(".scroll-view") || vp;
    }
    return null;
  }

  const viewport = (container) => container.querySelector(".scroll-view__viewport") || container;

  function userRows(container) {
    const vp = viewport(container);
    const vpTop = vp.getBoundingClientRect().top;
    const st = vp.scrollTop;
    return [...container.querySelectorAll(USER_ROW)]
      .map((el) => {
        const rc = el.getBoundingClientRect();
        return { id: el.getAttribute("data-message-id"), el, offset: st + (rc.top - vpTop), height: rc.height };
      })
      .sort((a, b) => a.offset - b.offset);
  }

  // The user message whose row centre is closest to `centre` (content coords). Compared
  // to nearestRow (row top vs an anchor), this stays put on the message you just centred,
  // whichever side of the viewport top its row started on.
  function nearestRowByCentre(rows, centre) {
    let best = null;
    let bestD = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.offset + (r.height || 0) / 2 - centre);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  const rowElById = (container, id) =>
    id ? container.querySelector(`${USER_ROW}[data-message-id="${CSS.escape(id)}"]`) : null;

  function nearestRow(rows, anchor) {
    let best = null;
    for (const r of rows) {
      if (best === null || Math.abs(r.offset - anchor) < Math.abs(best.offset - anchor)) best = r;
    }
    return best;
  }

  function pickNearest(rows, anchor, dir) {
    const skip = 24;
    let best = null;
    for (const r of rows) {
      if (dir < 0 ? r.offset < anchor - skip : r.offset > anchor + skip) {
        if (best === null || (dir < 0 ? r.offset > best.offset : r.offset < best.offset)) best = r;
      }
    }
    return best;
  }

  function renderedSpan(container) {
    let min = Infinity;
    let max = -Infinity;
    for (const r of container.querySelectorAll("[data-timeline-row]")) {
      // spacers are translated to the full content height; ignore them
      if ((r.getAttribute("data-timeline-row") || "").includes("spacer")) continue;
      const rc = r.getBoundingClientRect();
      if (rc.height === 0) continue;
      min = Math.min(min, rc.top);
      max = Math.max(max, rc.bottom);
    }
    return max > min ? max - min : 0;
  }

  function breakFollow(vp, dir) {
    try {
      vp.dispatchEvent(
        new WheelEvent("wheel", { deltaY: dir < 0 ? -400 : 400, deltaMode: 0, bubbles: true, cancelable: true }),
      );
    } catch {
      /* ignore */
    }
  }

  // page until an element matching `match` is rendered; steps stay inside the rendered
  // slice so no row can be skipped
  async function discover(container, vp, anchor, dir, match) {
    const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
    for (let i = 0; i < 25; i++) {
      const below = Math.max(0, (renderedSpan(container) - vp.clientHeight) / 2);
      const step = Math.max(vp.clientHeight, vp.clientHeight + below * 0.9);
      const next = clamp(vp.scrollTop + dir * step, 0, max);
      if (next === vp.scrollTop) return null;
      const before = Math.round(vp.scrollTop);
      vp.scrollTop = next;
      await waitRendered(container, vp);
      const rows = userRows(container);
      const hit = match ? rows.find(match) : pickNearest(rows, anchor, dir);
      if (hit) return hit;
      if (Math.round(vp.scrollTop) === before) return null; // scroll had no effect
    }
    return null;
  }

  // wait until the virtualizer has rendered a window that covers the current scroll
  // offset (checking for the mere presence of rows isn't enough - they can be stale)
  async function waitRendered(container, vp, budget = 1500) {
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      await Promise.race([raf(), sleep(50)]);
      const vpTop = vp.getBoundingClientRect().top;
      const st = vp.scrollTop;
      let min = Infinity;
      let max = -Infinity;
      for (const el of container.querySelectorAll("[data-timeline-row]")) {
        if ((el.getAttribute("data-timeline-row") || "").includes("spacer")) continue;
        const rc = el.getBoundingClientRect();
        if (!rc.height) continue;
        const top = st + (rc.top - vpTop);
        if (top < min) min = top;
        if (top + rc.height > max) max = top + rc.height;
      }
      if (min <= st + 2 && max >= st - 2) return;
    }
  }

  // index range of the user messages whose rows are currently rendered (rows of a turn,
  // including assistant parts, carry that turn's user message id)
  function renderedIndexRange(container) {
    let min = Infinity;
    let max = -Infinity;
    for (const el of container.querySelectorAll("[data-message-id]")) {
      const k = userIds ? userIds.indexOf(el.getAttribute("data-message-id")) : -1;
      if (k === -1) continue;
      if (k < min) min = k;
      if (k > max) max = k;
    }
    return min <= max ? { min, max } : null;
  }

  // binary-search the scroll offset until the target row is rendered (handles very
  // distant messages without paging through every screen)
  async function revealById(container, vp, targetId, targetIdx, anchor, dir) {
    const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
    if (rowElById(container, targetId)) return true;

    let lo = 0;
    let hi = max;
    for (let i = 0; i < 14; i++) {
      if (rowElById(container, targetId)) return true;
      const range = renderedIndexRange(container);
      let want;
      if (!range) {
        want = clamp(vp.scrollTop + dir * vp.clientHeight * 2, 0, max);
      } else if (targetIdx > range.max) {
        lo = Math.max(lo, vp.scrollTop + 1);
        want = (lo + hi) / 2;
      } else if (targetIdx < range.min) {
        hi = Math.min(hi, vp.scrollTop - 1);
        want = (lo + hi) / 2;
      } else {
        await waitRendered(container, vp);
        if (rowElById(container, targetId)) return true;
        want = clamp(vp.scrollTop + dir * vp.clientHeight * 0.5, 0, max);
      }
      want = clamp(want, 0, max);
      if (Math.abs(want - vp.scrollTop) < 3) break;
      vp.scrollTop = want;
      await waitRendered(container, vp);
    }
    if (rowElById(container, targetId)) return true;

    // fallback: linear sweep from the anchor, steps well inside the rendered window
    vp.scrollTop = clamp(anchor, 0, max);
    await waitRendered(container, vp);
    for (let i = 0; i < 60; i++) {
      if (rowElById(container, targetId)) return true;
      const step = Math.max(vp.clientHeight, vp.clientHeight * 3);
      const next = clamp(vp.scrollTop + dir * step, 0, max);
      if (next === vp.scrollTop) break;
      vp.scrollTop = next;
      await waitRendered(container, vp, 600);
    }
    return !!rowElById(container, targetId);
  }

  // centre a user message by id, re-measuring until it stops moving
  async function centerById(container, vp, id) {
    const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
    for (let i = 0; i < 6; i++) {
      const el = rowElById(container, id);
      if (!el) return false;
      const h = el.getBoundingClientRect().height;
      const offset = vp.scrollTop + (el.getBoundingClientRect().top - vp.getBoundingClientRect().top);
      const want = clamp(offset - (vp.clientHeight - h) / 2, 0, max);
      if (Math.abs(vp.scrollTop - want) < 1.5) return true;
      vp.scrollTop = want;
      await settle(2);
    }
    return !!rowElById(container, id);
  }

  function currentIndex(container, vp) {
    if (!userIds || !userIds.length) return -1;
    const cur = nearestRow(userRows(container), vp.scrollTop);
    return cur ? userIds.indexOf(cur.id) : -1;
  }

  async function navigate(dir) {
    const container = findContainer();
    if (!container) return;
    const vp = viewport(container);
    const sid = sq.activeSessionId();
    await refreshUserIds(sid);
    breakFollow(vp, dir);

    const anchor = vp.scrollTop;
    const max = Math.max(0, vp.scrollHeight - vp.clientHeight);

    let targetId = null;
    let targetIdx = -1;
    const cur = nearestRowByCentre(userRows(container), anchor + vp.clientHeight / 2);
    const idx = cur && userIds && sid === idsSession ? userIds.indexOf(cur.id) : -1;
    if (idx !== -1) {
      // Prev targets the current message itself when its row is entirely above the
      // viewport top (i.e. we scrolled past it - notably past the last message), and the
      // one before it otherwise; next always targets the following message. Locating the
      // current row by its centre (not the viewport top) keeps prev/next stable right
      // after a centred jump.
      const past = cur.offset + (cur.height || 0) <= anchor;
      const target = dir < 0 ? (past ? idx : idx - 1) : idx + 1;
      if (target < 0) return; // no previous user message
      if (target >= userIds.length) {
        vp.scrollTop = max; // no next user message: go to the very bottom
        return;
      }
      targetId = userIds[target];
      targetIdx = target;
    }

    if (targetId) {
      if (!rowElById(container, targetId)) {
        const ok = await revealById(container, vp, targetId, targetIdx, anchor, dir);
        if (!ok) {
          vp.scrollTop = anchor; // not found: don't move
          return;
        }
      }
      if (!(await centerById(container, vp, targetId))) vp.scrollTop = anchor;
      return;
    }

    const hit = pickNearest(userRows(container), anchor, dir) || (await discover(container, vp, anchor, dir));
    if (!hit) {
      vp.scrollTop = dir > 0 ? max : anchor; // nothing below → bottom; nothing above → stay
      return;
    }
    if (!(await centerById(container, vp, hit.id))) {
      vp.scrollTop = clamp(hit.offset - vp.clientHeight / 2, 0, max);
    }
  }

  // ---- UI -------------------------------------------------------------------
  let host = null;
  let upBtn = null;
  let downBtn = null;

  const buttonStyle = {
    width: "30px",
    height: "30px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "50%",
    background: "rgba(20,20,20,0.55)",
    color: "#e5e5e5",
    cursor: "pointer",
    padding: "0",
    backdropFilter: "blur(2px)",
  };

  function makeButton(dir, path, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    Object.assign(b.style, buttonStyle);
    b.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
      `<path d="${path}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.addEventListener("mouseenter", () => {
      if (!b.disabled) b.style.background = "rgba(60,60,60,0.8)";
    });
    b.addEventListener("mouseleave", () => (b.style.background = "rgba(20,20,20,0.55)"));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigate(dir);
    });
    return b;
  }

  function buildUI() {
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: "absolute",
      right: "10px",
      top: "50%",
      transform: "translateY(-50%)",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      zIndex: "50",
    });
    upBtn = makeButton(-1, "M4 10 L8 6 L12 10", "Previous message I sent");
    downBtn = makeButton(1, "M4 6 L8 10 L12 6", "Next message I sent");
    host.append(upBtn, downBtn);
  }

  function setBtn(btn, disabled) {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.35" : "1";
    btn.style.cursor = disabled ? "default" : "pointer";
  }

  function render() {
    if (!active || !upBtn) return;
    const container = findContainer();
    let upDisabled = false;
    let downDisabled = false;
    if (container) {
      const vp = viewport(container);
      const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
      // The down button stays live past the last user message (it jumps to the
      // bottom); it only greys out once the view is already at the very bottom.
      downDisabled = vp.scrollTop >= max - 2;
      if (userIds && userIds.length) {
        const idx = currentIndex(container, vp);
        if (idx !== -1) upDisabled = idx <= 0;
      }
    }
    setBtn(upBtn, upDisabled);
    setBtn(downBtn, downDisabled);
  }

  function attach() {
    if (!active) return;
    const container = findContainer();
    if (!container) {
      host.remove();
      bindScroll(null);
      observe(null);
      return;
    }
    if (host.parentElement !== container) container.appendChild(host);
    bindScroll(viewport(container));
    observe(container);
  }

  // ---- update scheduling ----------------------------------------------------
  // Updates are event-driven (scroll / DOM mutation / resize) and time-throttled, so
  // an idle app costs nothing and we never force layout on a fixed timer.
  let scheduled = 0;
  function schedule() {
    if (!active || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      attach();
      render();
    }, 120);
  }

  let observed = null;
  let observer = null;
  function observe(container) {
    if (observed === container) return;
    observed = container;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (container) {
      observer = new MutationObserver(schedule);
      observer.observe(container, { childList: true, subtree: true });
    }
  }

  let scrollVp = null;
  function bindScroll(vp) {
    if (scrollVp === vp) return;
    if (scrollVp) scrollVp.removeEventListener("scroll", schedule);
    scrollVp = vp;
    if (vp) vp.addEventListener("scroll", schedule, { passive: true });
  }

  // Low-frequency fallback: detects session/container switches and refreshes the
  // user-message index (itself cached). It does not render, so a quiet app stays quiet.
  let active = false;
  let unsubscribe = null;

  async function tick() {
    if (!active) return;
    attach();
    await refreshUserIds(sq.activeSessionId());
  }

  function mount() {
    active = true;
    buildUI();
    window.addEventListener("resize", schedule);
    unsubscribe = sq.every(2000, tick);
    tick().catch(() => {});
    render();
  }

  function unmount() {
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    window.removeEventListener("resize", schedule);
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = 0;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
      observed = null;
    }
    if (scrollVp) {
      scrollVp.removeEventListener("scroll", schedule);
      scrollVp = null;
    }
    if (host) host.remove();
    host = null;
    upBtn = null;
    downBtn = null;
  }

  window.__sqMessageJump = {
    dispose: unmount,
    navigate,
    attach,
    render,
    findContainer,
    viewport,
    userRows,
    nearestRow,
    renderedSpan,
    rowElById,
    centerById,
    revealById,
    renderedIndexRange,
    currentIndex,
    get userIds() {
      return userIds;
    },
    get idsSession() {
      return idsSession;
    },
  };
  reg.register(ID, {
    label: "Message Jump",
    version: "0.0.2",
    desc: "Jump to the previous/next message you sent.",
    enabled: false,
    mount,
    unmount,
  });

  console.log("[message-jump] registered");
})();
