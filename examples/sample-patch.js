// Sample OpenCode Desktop injection. Instead of drawing its own badge it pushes a
// line into the shared bottom-right overlay (see scripts/core.js).
//
//   python shuaqii.py --live -s scripts/core.js -s examples/sample-patch.js
//
// Demonstrates: overlay lines, a global keyboard hook, and a small helper surface.

(() => {
  const overlay = window.__sqOverlay;
  if (!overlay) {
    console.warn("[sample-patch] scripts/core.js must be injected first");
    return;
  }

  window.__samplePatch?.dispose?.();

  const ID = "sample-patch";

  overlay.set(ID, "CDP injected", { color: "#a3e635", title: location.href });

  const onKey = (e) => {
    if (e.key === "F5" && e.ctrlKey) {
      e.preventDefault();
      location.reload();
    }
  };
  window.addEventListener("keydown", onKey, true);

  window.$ocd = {
    version: "1",
    reload: () => location.reload(),
    q: (sel) => document.querySelector(sel),
    qa: (sel) => [...document.querySelectorAll(sel)],
  };

  const dispose = () => {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove(ID);
  };
  window.__samplePatch = { dispose };

  console.log("[sample-patch] active");
})();
