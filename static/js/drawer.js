"use strict";

// ---------------------------------------------------------------------
//  Drawer gestures: swipe in from the left edge (#edge) to pull it open,
//  swipe it left to close it. It follows the finger and settles by how
//  far it went or how fast it was flicked. Vertical moves stay scrolls;
//  sliders, timelines, breadcrumbs and a card being dragged are left alone.
// ---------------------------------------------------------------------
function initDrawerGestures() {
  const sb = document.getElementById("sidebar");
  let g = null;              // { id, x0, y0, t0, open, w, axis, off }
  let swiped = 0;

  const begin = (e, open) => {
    if (e.button !== undefined && e.button !== 0) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(),
          open, w: sb.offsetWidth, axis: null, off: open ? 0 : -sb.offsetWidth };
  };
  document.getElementById("edge").addEventListener("pointerdown", e => begin(e, false));
  sb.addEventListener("pointerdown", e => {
    if (!e.target.closest("input, .tl-track, .crumbs")) begin(e, true);
  });

  const reset = () => { sb.classList.remove("dragging"); sb.style.transform = ""; };
  window.addEventListener("pointermove", e => {
    if (!g || e.pointerId !== g.id) return;
    if (document.querySelector(".lib-card.dragging")) { reset(); g = null; return; }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
      if (g.axis === "y" || (g.open && dx > 0)) { g = null; return; }
      sb.classList.add("dragging");
    }
    g.off = g.open ? clamp(dx, -g.w, 0) : clamp(dx - g.w, -g.w, 0);
    sb.style.transform = `translateX(${g.off}px)`;
  });
  const end = e => {
    if (!g || e.pointerId !== g.id) return;
    if (g.axis === "x") {
      const v = (e.clientX - g.x0) / Math.max(1, performance.now() - g.t0);   // px/ms
      const open = v > 0.45 ? true : v < -0.45 ? false : g.off > -g.w / 2;
      reset();
      sb.classList.toggle("open", open);
      if (open) refreshMosaics();
      swiped = Date.now();
    }
    g = null;
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  // A swipe must not also count as a tap on whatever it started on.
  sb.addEventListener("click", e => {
    if (Date.now() - swiped < 350) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

// Phone layout (css/phone.css): bottom bar, full-screen drawer.
const PHONE = "(max-width: 700px)";
const isPhone = () => matchMedia(PHONE).matches;

function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); }
