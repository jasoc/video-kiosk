"use strict";

// ---------------------------------------------------------------------
//  Track: a timeline bar with a playhead and two range handles. Used by
//  every tile's overlay and by the tile editor. Pure UI: it owns no
//  video, it reports what the finger does through callbacks.
// ---------------------------------------------------------------------
const MIN_RANGE = 1;           // shortest selectable range, seconds

class Track {
  constructor({ seekable = () => true, onStart, onPreview, onSeek, onRange }) {
    this.el = document.createElement("div");
    this.el.className = "tl-track";
    this.el.innerHTML =
      '<div class="tl-sel"></div><div class="tl-head"></div>' +
      '<div class="tl-h"></div><div class="tl-h"></div>';
    [this.selEl, this.headEl, ...this.handles] = this.el.children;
    stopDrag(this.el);
    this.dur = 0;
    this.range = null;         // [a, b] or null = the whole file
    this.now = 0;
    this.drag = null;          // { kind: null (scrub) | 0 | 1 (handle), t, range }

    const timeAt = x => {
      const r = this.el.getBoundingClientRect();
      return clamp((x - r.left) / r.width, 0, 1) * this.dur;
    };
    this.el.addEventListener("pointerdown", e => {
      if (!this.dur) return;
      // A press within reach of a handle grabs it, anywhere else scrubs.
      const [a, b] = this.range || [0, this.dur];
      const r = this.el.getBoundingClientRect();
      const px = t => r.left + t / this.dur * r.width;
      const da = Math.abs(e.clientX - px(a)), db = Math.abs(e.clientX - px(b));
      let kind = null;
      if (Math.min(da, db) < 24) kind = da < db || (da === db && e.clientX < px(a)) ? 0 : 1;
      if (kind === null && !seekable()) return;
      this.drag = { kind, t: this.now, range: kind === null ? null : [a, b] };
      try { this.el.setPointerCapture(e.pointerId); } catch (err) {}
      onStart?.();
      move(e);
    });
    const move = e => {
      const d = this.drag;
      if (!d) return;
      let t = timeAt(e.clientX);
      if (d.kind === null) d.t = t;
      else if (d.kind === 0) t = d.range[0] = clamp(t, 0, d.range[1] - MIN_RANGE);
      else t = d.range[1] = clamp(t, d.range[0] + MIN_RANGE, this.dur);
      this.paint();
      onPreview?.(t);
    };
    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.kind === null) onSeek?.(d.t);
      else onRange?.(d.range, d.kind);
      this.paint();
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
    this.el.addEventListener("click", e => e.stopPropagation());
  }

  set(dur, range, now) {
    this.dur = dur || 0;
    this.range = range;
    if (!this.drag) this.now = now;
    this.paint();
  }

  // "now / total" normally, "from – to" while a handle is being dragged.
  label() {
    if (this.drag?.range) return `${fmtTime(this.drag.range[0])} – ${fmtTime(this.drag.range[1])}`;
    const now = this.drag ? this.drag.t : this.now;
    return `${fmtTime(now)} / ${fmtTime(this.dur)}`;
  }

  paint() {
    const d = this.dur || 1, pct = t => clamp(t / d, 0, 1) * 100;
    const [a, b] = this.drag?.range || this.range || [0, this.dur];
    this.selEl.style.left = pct(a) + "%";
    this.selEl.style.right = 100 - pct(b) + "%";
    this.selEl.classList.toggle("cut", !!(this.drag?.range || this.range));
    this.handles[0].style.left = pct(a) + "%";
    this.handles[1].style.left = pct(b) + "%";
    this.headEl.style.left = pct(this.drag?.kind === null ? this.drag.t : this.now) + "%";
  }
}

// fastSeek lands on a keyframe: imprecise, but light enough to scrub with.
function previewSeek(v, t) {
  if (v.fastSeek) v.fastSeek(t); else v.currentTime = t;
}
