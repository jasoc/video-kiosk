// =====================================================================
//  Video Kiosk — tree + random clip loops + mosaic grid
//
//  Playback: each tile owns TWO <video> elements (double buffer), reused
//  forever. While one plays, the next clip is prefetched on the hidden
//  one, then swapped with a crossfade. No element is ever created per
//  clip, so client memory stays flat.
//
//  Per tile: one or more scopes mixed together (drop a library entry on
//  a tile to add one), mode "clips" (random clips, 5..60s) or "full"
//  (whole videos, with a seek bar), a zoom mode (fill / fit / smart crop)
//  and, per file, a cut: the part of the video to loop or draw clips from.
//  Mosaics (tiles + settings + geometry) are JSON files on the server,
//  shared by every client.
//
//  The grid does not gravitate: tiles stay exactly where they are put,
//  and a new tile only ever takes free space (or half of the biggest
//  tile when the canvas is full).
// =====================================================================

"use strict";

const MAX_TILES = 6;
const GRID_COLS = 12;
const GRID_ROWS = 12;
const PRESS_MS = 350;          // long-press before a tree drag starts
const DRAG_SLOP = 12;          // px of movement that cancels a press
const DURATIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const LEGACY_KEY = "kiosk.mosaics"; // pre-server localStorage mosaics

// Zoom cycle. "smart" crops the black bars baked inside the frame.
const ZOOMS = [
  { id: "fill",  icon: "crop",         title: "Riempi il tassello" },
  { id: "fit",   icon: "fit_screen",   title: "Adatta: nessun taglio" },
  { id: "smart", icon: "auto_fix_high", title: "Zoom automatico: toglie le bande nere" },
];

let grid;                      // GridStack instance
let paused = false;
let currentPreset = "auto";
const tiles = new Map();       // gridstack item el -> Tile
const openDirs = new Set();    // folder paths expanded in the tree
let libFiles = [];             // every video path, in tree order

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------
//  Layout presets
// ---------------------------------------------------------------------
const AUTO_LAYOUTS = {
  1: [[0, 0, 12, 12]],
  2: [[0, 0, 6, 12], [6, 0, 6, 12]],
  3: [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 12, 6]],
  4: [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 6, 6], [6, 6, 6, 6]],
  5: [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 6, 6], [6, 6, 6, 6]],
  6: [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 4, 6], [4, 6, 4, 6], [8, 6, 4, 6]],
};

function splitEven(n, total = GRID_COLS) {
  const base = Math.floor(total / n), rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// Irregular layout computed on the spot: split the canvas recursively,
// picking the direction that keeps tiles from getting too thin on THIS
// screen and the ratio at random. Some tiles end up big, some small, and
// tapping the preset again rolls a different arrangement.
function randomSplit(n) {
  const canvas = document.getElementById("canvas");
  const cw = (canvas.clientWidth || 1280) / GRID_COLS;
  const ch = (canvas.clientHeight || 800) / GRID_ROWS;
  const MIN = n > 4 ? 2 : 3;
  const ratios = [0.5, 0.5, 0.42, 0.58, 0.34, 0.66];
  const rects = [[0, 0, GRID_COLS, GRID_ROWS]];

  while (rects.length < n) {
    const cand = rects
      .map((r, i) => i)
      .filter(i => rects[i][2] >= MIN * 2 || rects[i][3] >= MIN * 2)
      .sort((a, b) => rects[b][2] * rects[b][3] - rects[a][2] * rects[a][3]);
    if (!cand.length) break;
    // Usually cut the biggest rectangle, sometimes a smaller one — that
    // is what makes the result uneven instead of a plain grid.
    const i = Math.random() < 0.7
      ? cand[0]
      : cand[Math.floor(Math.random() * Math.min(3, cand.length))];
    const [x, y, w, h] = rects[i];
    const canV = w >= MIN * 2, canH = h >= MIN * 2;
    const wide = (w * cw) / (h * ch) > 1.35;
    const vert = canV && (!canH || Math.random() < (wide ? 0.85 : 0.25));
    const r = ratios[Math.floor(Math.random() * ratios.length)];
    if (vert) {
      const a = clamp(Math.round(w * r), MIN, w - MIN);
      rects.splice(i, 1, [x, y, a, h], [x + a, y, w - a, h]);
    } else {
      const a = clamp(Math.round(h * r), MIN, h - MIN);
      rects.splice(i, 1, [x, y, w, a], [x, y + a, w, h - a]);
    }
  }
  return rects;
}

const PRESETS = {
  auto:   { label: "Auto", icon: "auto_awesome_mosaic",
            fits: n => n >= 1 && n <= 6, gen: n => AUTO_LAYOUTS[n] },
  smart:  { label: "Sorprendimi", icon: "auto_awesome", random: true,
            fits: n => n >= 2 && n <= MAX_TILES, gen: n => randomSplit(n) },
  hero:   { label: "Protagonista", icon: "featured_video",
            fits: n => n >= 2 && n <= 6,
            gen: n => { let y = 0; const out = [[0, 0, 8, GRID_ROWS]];
                        for (const h of splitEven(n - 1, GRID_ROWS)) { out.push([8, y, 4, h]); y += h; }
                        return out; } },
  cols:   { label: "Colonne", icon: "view_column",
            fits: n => n >= 2 && n <= 6,
            gen: n => { let x = 0; return splitEven(n).map(w => { const r = [x, 0, w, 12]; x += w; return r; }); } },
  rows:   { label: "Righe", icon: "table_rows",
            fits: n => n >= 2 && n <= 6,
            gen: n => { let y = 0; return splitEven(n, GRID_ROWS).map(h => { const r = [0, y, 12, h]; y += h; return r; }); } },
  grid22: { label: "Griglia 2×2", icon: "grid_view",
            fits: n => n >= 2 && n <= 4,
            gen: n => [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 6, 6], [6, 6, 6, 6]].slice(0, n) },
  grid32: { label: "Griglia 3×2", icon: "grid_on",
            fits: n => n >= 2 && n <= 6,
            gen: n => [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 4, 6], [4, 6, 4, 6], [8, 6, 4, 6]].slice(0, n) },
};

function layoutFor(n) {
  const p = PRESETS[currentPreset];
  const out = (p && p.fits(n) ? p : PRESETS.auto).gen(n);
  // A generator can give up early (no rectangle left to split): never
  // hand back fewer rects than tiles.
  return out && out.length >= n ? out : AUTO_LAYOUTS[clamp(n, 1, 6)];
}

// ---------------------------------------------------------------------
//  Smart crop detection
//
//  Plenty of "horizontal" videos are really a vertical clip with black
//  bars baked into the frame. One 64px-wide sample of a frame is enough
//  to find the real content box, which "smart" zoom then blows up to
//  fill the tile. Cheap (a few ms), same-origin so the canvas is clean,
//  and cached per file. It can be fooled by a very dark frame, which is
//  why the button cycles: one more tap and you are back to fill/fit.
// ---------------------------------------------------------------------
const cropCache = new Map();   // file -> {x, y, w, h} in 0..1 video coords
let probeCanvas = null;

function detectCrop(el, file) {
  if (cropCache.has(file)) return cropCache.get(file);
  const vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return null;
  const W = 64, H = Math.max(8, Math.round(W * vh / vw));
  probeCanvas ||= document.createElement("canvas");
  probeCanvas.width = W;
  probeCanvas.height = H;
  const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
  let px;
  try {
    ctx.drawImage(el, 0, 0, W, H);
    px = ctx.getImageData(0, 0, W, H).data;
  } catch (e) {
    return null;
  }

  const LIT = 26 * 3;          // r+g+b above this is not a black bar
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i] + px[i + 1] + px[i + 2] < LIT) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  // A (nearly) black frame says nothing: don't cache, try again later.
  if (x1 < 0 || w * h < W * H * 0.12) return null;
  const box = w > W * 0.96 && h > H * 0.96
    ? { x: 0, y: 0, w: 1, h: 1 }
    : { x: x0 / W, y: y0 / H, w: w / W, h: h / H };
  if (cropCache.size > 400) cropCache.clear();
  cropCache.set(file, box);
  return box;
}

// ---------------------------------------------------------------------
//  Track: a timeline bar with a playhead and two range handles. Used by
//  every tile's overlay and by the trim dialog. Pure UI: it owns no
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

// ---------------------------------------------------------------------
//  Tile: one video slot in the grid, looping its scopes
// ---------------------------------------------------------------------
const scopeLabel = p => p ? p.split("/").pop() : "Tutti i video";

// "a + b", with "×2" when the same scope was dropped twice (more weight).
function scopeTitle(scopes) {
  const n = new Map();
  for (const s of scopes) n.set(s, (n.get(s) || 0) + 1);
  return [...n].map(([s, k]) => scopeLabel(s) + (k > 1 ? ` ×${k}` : "")).join(" + ");
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// {file: [from, to]} as stored in a mosaic, dropping anything malformed.
function cleanRanges(r) {
  const out = {};
  if (r && typeof r === "object")
    for (const [f, v] of Object.entries(r))
      if (Array.isArray(v) && v[1] - v[0] >= MIN_RANGE) out[f] = [+v[0], +v[1]];
  return out;
}

class Tile {
  constructor(contentEl, scopes, opts = {}) {
    // "" = root, folder paths and/or file paths. Several = a mixed tile;
    // the same scope twice simply weighs double.
    this.scopes = scopes.length ? [...scopes] : [""];
    this.mode = opts.mode === "full" ? "full" : "clips";
    this.duration = DURATIONS.includes(opts.duration) ? opts.duration : 20;
    this.zoom = ZOOMS.some(z => z.id === opts.zoom) ? opts.zoom : "fill";
    this.ranges = cleanRanges(opts.ranges);   // file -> [from, to] seconds
    this.gen = 0;              // bumped to cancel stale async work
    this.timer = null;
    this.cropT = null;
    this.crop = null;
    this.clip = null;
    this.next = null;          // { clip, el } prefetched and ready
    this.active = 0;
    this.root = contentEl;

    this.videos = [this.makeVideo(), this.makeVideo()];
    this.spinner = document.createElement("div");
    this.spinner.className = "tile-spinner";
    this.spinner.innerHTML = '<span class="material-icons-round">hourglass_top</span>';

    // --- overlay: title row, timeline row, controls row ---
    this.overlay = document.createElement("div");
    this.overlay.className = "tile-overlay";

    this.title = document.createElement("div");
    this.title.className = "tile-title";
    this.scopeEl = document.createElement("button");
    this.scopeEl.className = "tile-scope";
    this.scopeEl.title = "Taglia i video di questo tassello";
    this.scopeEl.innerHTML = '<span class="material-icons-round">content_cut</span><span></span>';
    this.scopeText = this.scopeEl.lastChild;
    stopDrag(this.scopeEl);
    this.scopeEl.addEventListener("click", e => { e.stopPropagation(); openTrim(this); });
    this.fileEl = document.createElement("span");
    this.fileEl.className = "tile-file";
    this.fileEl.textContent = scopeTitle(this.scopes);
    this.title.append(this.scopeEl, this.fileEl);

    this.tl = document.createElement("div");
    this.tl.className = "tile-tl";
    this.playBtn = tileBtn("pause", () => this.togglePlay());
    this.track = new Track({
      seekable: () => this.mode === "full",
      onStart: () => clearTimeout(this.timer),
      onPreview: t => {
        previewSeek(this.videos[this.active], t);
        this.showOverlay();
      },
      onSeek: t => {
        const v = this.videos[this.active];
        v.currentTime = t;
        if (!v.paused) this.armTimer();
        this.showOverlay();
      },
      onRange: (r, which) => this.setRange(this.clip.file, r, this.clip.dur, which),
    });
    this.timeEl = document.createElement("span");
    this.timeEl.className = "tl-time";
    this.resetBtn = tileBtn("restart_alt", () => this.setRange(this.clip.file, null, this.clip.dur));
    this.resetBtn.title = "Usa tutto il video";
    this.tl.append(this.playBtn, this.track.el, this.timeEl, this.resetBtn);

    const bar = document.createElement("div");
    bar.className = "tile-bar";
    this.durBtn = tilePill(() => this.toggleDurPanel());
    this.zoomBtn = tileBtn("crop", () => this.cycleZoom());
    this.modeBtn = tileBtn("shuffle", () => this.toggleMode());
    const spacer = document.createElement("span");
    spacer.className = "tile-spacer";
    const dup = tileBtn("content_copy", () => duplicateTile(this.root.parentElement));
    dup.title = "Duplica il tassello";
    const skip = tileBtn("skip_next", () => this.advance());
    skip.title = "Prossima clip";
    const close = tileBtn("close", () => removeTile(this.root.parentElement));
    close.title = "Rimuovi";
    bar.append(this.durBtn, this.zoomBtn, this.modeBtn, spacer, dup, skip, close);
    this.overlay.append(this.title, this.tl, bar);

    // --- clip duration panel ---
    this.durPanel = document.createElement("div");
    this.durPanel.className = "tile-durs";
    const durTitle = document.createElement("span");
    durTitle.className = "tile-durs-title";
    durTitle.textContent = "Durata clip";
    const durGrid = document.createElement("div");
    durGrid.className = "tile-durs-grid";
    for (const d of DURATIONS) {
      const b = document.createElement("button");
      b.className = "dur-opt";
      b.textContent = d + "s";
      b.dataset.dur = d;
      stopDrag(b);
      b.addEventListener("click", e => {
        e.stopPropagation();
        this.setDuration(d);
      });
      durGrid.append(b);
    }
    this.durPanel.append(durTitle, durGrid);
    stopDrag(this.durPanel);

    this.root.append(this.videos[0], this.videos[1], this.spinner,
                     this.durPanel, this.overlay);

    this.overlayT = null;
    this.root.addEventListener("click", () => this.showOverlay());
    this.updateControls();
    this.applyZoom();
    this.advance();
  }

  makeVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.addEventListener("ended", () => {
      if (!paused && !v.loop && v === this.videos[this.active]) this.clipEnd();
    });
    // Keep the timeline live, but only while somebody can see it.
    const live = () => {
      if (v === this.videos[this.active] && !this.track.drag &&
          this.overlay.classList.contains("visible")) this.renderTimeline();
    };
    for (const ev of ["timeupdate", "play", "pause"]) v.addEventListener(ev, live);
    return v;
  }

  // The tile plays exactly one file: full mode can loop it in place.
  isFile(clip) {
    return !!clip && this.scopes.length === 1 && clip.file === this.scopes[0];
  }

  // The selection that applies to `clip`, clamped to its length, or null.
  rangeFor(clip) {
    const r = clip && this.ranges[clip.file];
    if (!r) return null;
    const a = clamp(r[0], 0, clip.dur), b = clamp(r[1], 0, clip.dur);
    return b - a >= MIN_RANGE ? [a, b] : null;
  }

  showOverlay() {
    this.overlay.classList.add("visible");
    this.renderTimeline();
    clearTimeout(this.overlayT);
    this.overlayT = setTimeout(() => {
      this.overlay.classList.remove("visible");
      this.durPanel.classList.remove("visible");
    }, 3500);
  }

  updateControls() {
    this.modeBtn.querySelector("span").textContent =
      this.mode === "clips" ? "shuffle" : "repeat";
    this.modeBtn.title = this.mode === "clips" ? "Clip casuali" : "Video interi";
    const z = ZOOMS.find(z => z.id === this.zoom);
    this.zoomBtn.querySelector("span").textContent = z.icon;
    this.zoomBtn.title = z.title;
    this.zoomBtn.classList.toggle("on", this.zoom === "smart");
    this.durBtn.textContent = this.duration + "s";
    this.durBtn.style.display = this.mode === "clips" ? "" : "none";
    this.durPanel.querySelectorAll(".dur-opt").forEach(b =>
      b.classList.toggle("active", +b.dataset.dur === this.duration));
    this.renderTimeline();
  }

  // Title: the file being played and which scope(s) it comes from. The
  // scope chip opens the trim dialog; a single-file tile hides it (its
  // own timeline is all there is to cut).
  updateTitle(clip) {
    const parts = clip.file.split("/");
    this.fileEl.textContent = parts.pop();
    const whole = this.scopes.length === 1 && !this.scopes[0];
    this.scopeText.textContent = whole
      ? (parts.length ? parts[parts.length - 1] : "Libreria")
      : scopeTitle(this.scopes);
    this.scopeEl.style.display = this.isFile(clip) ? "none" : "";
  }

  // Timeline of the clip on screen: handles to cut it (any mode, any
  // scope), plus scrubbing and play/pause in full mode.
  renderTimeline() {
    const clip = this.clip;
    this.tl.style.display = clip ? "" : "none";
    if (!clip) return;
    const v = this.videos[this.active];
    this.track.set(clip.dur || v.duration, this.rangeFor(clip), v.currentTime);
    this.playBtn.style.display = this.mode === "full" ? "" : "none";
    this.playBtn.querySelector("span").textContent = v.paused ? "play_arrow" : "pause";
    this.resetBtn.style.display = this.rangeFor(clip) ? "" : "none";
    this.timeEl.textContent = this.track.label();
  }

  // Store the selection of one file (null or the whole file = no cut). If
  // that file is on screen its window is re-cut in place, same element,
  // no reload; `which` = the handle just moved, so ending on the end
  // handle lets you hear the cut point.
  setRange(file, range, dur, which = 0) {
    if (range && (range[0] > 0.1 || range[1] < dur - 0.1))
      this.ranges[file] = [Math.round(range[0] * 100) / 100, Math.round(range[1] * 100) / 100];
    else
      delete this.ranges[file];
    // A prefetched clip of the same file may now start outside the cut.
    if (this.next?.clip.file === file) {
      this.next = null;
      this.prefetch();
    }
    const clip = this.clip;
    if (!clip || clip.file !== file) return;
    const v = this.videos[this.active];
    const r = this.rangeFor(clip);
    const [a, b] = r || [0, clip.dur];
    if (this.mode === "full") {
      clip.start = a;
      clip.length = b - a;
      if (this.isFile(clip)) v.loop = !r;
    } else {
      clip.length = Math.min(this.duration, b - a);
      clip.start = which === 1 ? b - clip.length : a;
    }
    v.currentTime = which === 1
      ? Math.max(clip.start, clip.start + clip.length - 3) : clip.start;
    if (!v.paused) this.armTimer();
    this.showOverlay();
  }

  togglePlay() {
    const v = this.videos[this.active];
    if (v.paused) {
      v.play().catch(() => {});
      this.armTimer();
    } else {
      v.pause();
      clearTimeout(this.timer);
    }
    this.showOverlay();
  }

  // Dropping another library entry on this tile mixes it in. Dropping one
  // that is already there is allowed: it just weighs double.
  addScope(scope) {
    this.scopes.push(scope);
    this.next = null;
    this.advance();
    toast(`Mescolati: ${scopeTitle(this.scopes)}`);
  }

  // Everything needed to rebuild this tile elsewhere (duplicate, mosaic).
  settings() {
    return { scopes: [...this.scopes], mode: this.mode, duration: this.duration,
             zoom: this.zoom, ranges: { ...this.ranges } };
  }

  toggleMode() {
    this.mode = this.mode === "clips" ? "full" : "clips";
    this.durPanel.classList.remove("visible");
    this.updateControls();
    this.showOverlay();
    this.next = null;
    this.advance();
  }

  toggleDurPanel() {
    this.durPanel.classList.toggle("visible");
    this.showOverlay();
  }

  setDuration(d) {
    this.duration = d;
    this.durPanel.classList.remove("visible");
    this.updateControls();
    this.showOverlay();
    this.next = null;          // applies from the next clip
    this.advance();
  }

  cycleZoom() {
    const i = ZOOMS.findIndex(z => z.id === this.zoom);
    this.zoom = ZOOMS[(i + 1) % ZOOMS.length].id;
    this.updateControls();
    this.showOverlay();
    this.refreshCrop();
  }

  // Re-detect the content box of the current clip (smart zoom only).
  refreshCrop() {
    clearTimeout(this.cropT);
    this.crop = null;
    if (this.zoom !== "smart" || !this.clip) {
      this.applyZoom();
      return;
    }
    const gen = this.gen, file = this.clip.file;
    const attempt = left => {
      if (gen !== this.gen) return;
      this.crop = detectCrop(this.videos[this.active], file);
      this.applyZoom();
      if (!this.crop && left > 0)
        this.cropT = setTimeout(() => attempt(left - 1), 700);
    };
    attempt(3);
  }

  applyZoom() {
    const front = this.videos[this.active];
    for (const v of this.videos) {
      v.style.objectFit = this.zoom === "fill" ? "cover" : "contain";
      v.style.transform = "";
    }
    if (this.zoom !== "smart" || !this.crop) return;
    const box = this.crop;
    const tw = this.root.clientWidth, th = this.root.clientHeight;
    const vw = front.videoWidth, vh = front.videoHeight;
    if (!tw || !th || !vw || !vh) return;
    // object-fit: contain puts the frame on screen at scale s; blow the
    // content box up until it covers the tile and re-centre it.
    const s = Math.min(tw / vw, th / vh);
    const k = clamp(Math.max(tw / (box.w * vw * s), th / (box.h * vh * s)), 1, 8);
    const dx = (box.x + box.w / 2 - 0.5) * vw * s;
    const dy = (box.y + box.h / 2 - 0.5) * vh * s;
    front.style.transform = `translate(${-k * dx}px, ${-k * dy}px) scale(${k})`;
  }

  async fetchClip() {
    const params = new URLSearchParams({ duration: this.duration });
    for (const s of this.scopes) params.append("target", s);
    const res = await fetch(`/random?${params}`);
    if (!res.ok) throw new Error("no clips");
    const clip = await res.json();
    // A cut narrows the window: full mode plays exactly it, clips mode
    // draws its in-point from inside it.
    const r = this.rangeFor(clip);
    const [a, b] = r || [0, clip.dur];
    if (this.mode === "full") {
      clip.start = a;
      clip.length = b - a;
    } else if (r) {
      clip.length = Math.min(this.duration, b - a);
      clip.start = a + Math.random() * (b - a - clip.length);
    }
    return clip;
  }

  // Load clip into el and resolve when it can play from clip.start.
  prepare(el, clip) {
    return new Promise((resolve, reject) => {
      const gen = this.gen;
      clearTimeout(el._failT);           // cancel a previous load's watchdog
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(el._failT);
        el.oncanplay = el.onloadedmetadata = el.onerror = null;
        ok && gen === this.gen ? resolve() : reject(new Error("stale"));
      };
      el._failT = setTimeout(() => done(false), 10000);
      el.onerror = () => done(false);
      el.onloadedmetadata = () => {
        try { el.currentTime = clip.start; } catch (e) { /* seek on play */ }
        el.oncanplay = () => done(true);
      };
      el.src = videoUrl(clip.file);
      el.load();
    });
  }

  // Show the next clip: use the prefetched one if ready, otherwise load.
  async advance() {
    const gen = ++this.gen;
    clearTimeout(this.timer);
    let clip, el, fails = 0;

    if (this.next) {
      ({ clip, el } = this.next);
      this.next = null;
    } else {
      this.spinner.classList.add("visible");
      while (true) {
        try {
          clip = await this.fetchClip();
          el = this.videos[1 - this.active];
          await this.prepare(el, clip);
          break;
        } catch (e) {
          if (gen !== this.gen) return;
          if (e.message === "stale") return;
          if (++fails >= 2) libraryTrouble();
          await new Promise(r => setTimeout(r, 2000));
          if (gen !== this.gen) return;
        }
      }
    }
    if (gen !== this.gen) return;
    this.spinner.classList.remove("visible");

    const old = this.videos[this.active];
    this.active = this.videos.indexOf(el);
    this.clip = clip;
    el.classList.add("front");
    old.classList.remove("front");
    old.pause();

    // A full-mode tile on a single file loops in place: natively when it
    // plays the whole file (seamless, no timers), by seeking back when it
    // is cut. Either way no prefetch traffic.
    const self = this.mode === "full" && this.isFile(clip);
    el.loop = self && !this.rangeFor(clip);

    el.muted = tiles.size > 1;      // audio only in single view
    if (!paused) {
      el.play().catch(() => {});
      this.armTimer();
    }
    this.updateTitle(clip);
    this.renderTimeline();
    this.refreshCrop();
    if (!self) this.prefetch();
  }

  armTimer() {
    clearTimeout(this.timer);
    const v = this.videos[this.active];
    if (!this.clip || v.loop) return;
    const remaining = (this.clip.start + this.clip.length) - v.currentTime;
    this.timer = setTimeout(() => this.clipEnd(), Math.max(0.3, remaining) * 1000);
  }

  // The current window is over: a full-mode single file loops its cut in
  // place, everything else moves on to the next clip.
  clipEnd() {
    const v = this.videos[this.active];
    if (this.mode !== "full" || !this.isFile(this.clip)) {
      this.advance();
      return;
    }
    // The timer runs on wall time; after a stall the video may lag behind.
    if (v.currentTime < this.clip.start + this.clip.length - 0.3 && !v.ended) {
      this.armTimer();
      return;
    }
    v.currentTime = this.clip.start;
    v.play().catch(() => {});
    this.armTimer();
  }

  async prefetch() {
    const gen = this.gen;
    try {
      const clip = await this.fetchClip();
      if (gen !== this.gen) return;
      const el = this.videos[1 - this.active];
      await this.prepare(el, clip);
      if (gen === this.gen) this.next = { clip, el };
    } catch (e) { /* advance() will load on demand */ }
  }

  setPaused(p) {
    const v = this.videos[this.active];
    if (p) {
      clearTimeout(this.timer);
      v.pause();
    } else {
      v.play().catch(() => {});
      this.armTimer();
    }
  }

  destroy() {
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.overlayT);
    clearTimeout(this.cropT);
    for (const v of this.videos) {
      v.pause();
      v.removeAttribute("src");
      v.load();                 // release decoder + buffers
    }
    this.root.replaceChildren();
  }
}

// In a mosaic ask the server for a low-res proxy: six full-quality
// streams are what makes a tablet stutter. A single tile (the only one
// with audio) always gets the original.
const encodePath = file => file.split("/").map(encodeURIComponent).join("/");

function videoUrl(file) {
  // getGridItems() (not tiles.size) so a tile loading its very first clip
  // already counts itself.
  const many = grid.getGridItems().length > 1;
  return `/video/${encodePath(file)}${many ? "?q=low" : ""}`;
}

function stopDrag(el) {
  // Don't let gridstack treat presses on controls as a drag start.
  for (const ev of ["pointerdown", "mousedown", "touchstart"])
    el.addEventListener(ev, e => e.stopPropagation());
}

function tileBtn(icon, onTap) {
  const b = document.createElement("button");
  b.className = "tile-btn";
  b.innerHTML = `<span class="material-icons-round">${icon}</span>`;
  stopDrag(b);
  b.addEventListener("click", e => { e.stopPropagation(); onTap(); });
  return b;
}

function tilePill(onTap) {
  const b = document.createElement("button");
  b.className = "tile-pill";
  stopDrag(b);
  b.addEventListener("click", e => { e.stopPropagation(); onTap(); });
  return b;
}

// ---------------------------------------------------------------------
//  Grid management
// ---------------------------------------------------------------------
function cellHeight() {
  return document.getElementById("canvas").clientHeight / GRID_ROWS;
}

function initGrid() {
  grid = GridStack.init({
    column: GRID_COLS,
    maxRow: GRID_ROWS,
    cellHeight: cellHeight(),
    margin: 3,
    float: true,          // no gravity: a tile stays where you drop it
    animate: true,
    resizable: { handles: "se" },
  }, "#grid");
  grid.on("resizestop", (e, el) => tiles.get(el)?.applyZoom());
  window.addEventListener("resize", () => {
    grid.cellHeight(cellHeight());
    reZoom();
  });
}

// Smart zoom is computed from the tile's pixel size, so re-run it once the
// grid animation has settled.
function reZoom() {
  for (const t of tiles.values()) t.applyZoom();
  setTimeout(() => { for (const t of tiles.values()) t.applyZoom(); }, 400);
}

// Geometry of a grid item. gridstackNode is authoritative; the gs-*
// attributes are the fallback (and what a manual drag/resize writes back).
function itemRect(el) {
  const n = el.gridstackNode || {};
  const attr = (name, dflt) => {
    const v = el.getAttribute(name);
    return v === null || v === "" ? dflt : +v;
  };
  return {
    el,
    x: n.x ?? attr("gs-x", 0), y: n.y ?? attr("gs-y", 0),
    w: n.w ?? attr("gs-w", 1), h: n.h ?? attr("gs-h", 1),
  };
}

function occupancy() {
  const g = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(false));
  for (const el of grid.getGridItems()) {
    const r = itemRect(el);
    for (let y = r.y; y < Math.min(GRID_ROWS, r.y + r.h); y++)
      for (let x = r.x; x < Math.min(GRID_COLS, r.x + r.w); x++)
        g[y][x] = true;
  }
  return g;
}

// Biggest free rectangle (roughly square wins ties), or null if the
// canvas is completely covered.
function freeRect() {
  const g = occupancy();
  let best = null, bestScore = 0;
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      if (g[y][x]) continue;
      let maxW = GRID_COLS - x;
      for (let h = 1; y + h <= GRID_ROWS; h++) {
        let w = 0;
        while (w < maxW && !g[y + h - 1][x + w]) w++;
        maxW = Math.min(maxW, w);
        if (!maxW) break;
        const score = maxW * h * Math.min(maxW, h) / Math.max(maxW, h);
        if (score > bestScore) { bestScore = score; best = { x, y, w: maxW, h }; }
      }
    }
  }
  return best;
}

// Where to put a new tile. Free space first — even a tiny hole, the user
// can resize afterwards. Only when the canvas is completely covered do we
// carve half of a tile (`prefer` if given, else the biggest), so at most
// ONE existing tile changes and none of them ever moves.
function placeNew(prefer) {
  const free = freeRect();
  if (free) return free;
  const items = grid.getGridItems().map(itemRect)
    .sort((a, b) => (b.el === prefer) - (a.el === prefer) || b.w * b.h - a.w * a.h);
  for (const it of items) {
    if (it.w >= 2 && it.w >= it.h) {
      const half = Math.floor(it.w / 2);
      grid.update(it.el, { w: it.w - half });
      return { x: it.x + it.w - half, y: it.y, w: half, h: it.h };
    }
    if (it.h >= 2) {
      const half = Math.floor(it.h / 2);
      grid.update(it.el, { h: it.h - half });
      return { x: it.x, y: it.y + it.h - half, w: it.w, h: half };
    }
  }
  return null;
}

function applyLayout() {
  const items = grid.getGridItems();
  if (!items.length) return;
  const layout = layoutFor(items.length);
  grid.batchUpdate();
  items.forEach((el, i) => {
    const [x, y, w, h] = layout[i];
    grid.update(el, { x, y, w, h });
  });
  grid.batchUpdate(false);
  reZoom();
}

function updateAudio() {
  const single = tiles.size === 1;
  for (const t of tiles.values())
    t.videos[t.active].muted = !single;
}

function addTile(scopes, opts = {}) {
  if (tiles.size >= MAX_TILES) {
    toast(`Massimo ${MAX_TILES} video nel mosaico`);
    return null;
  }
  hideStart();
  const rect = opts.rect || placeNew(opts.near);
  if (!rect) {
    toast("Non c'è più spazio: ridimensiona un tassello");
    return null;
  }
  const el = grid.addWidget(rect);
  const tile = new Tile(el.querySelector(".grid-stack-item-content"), scopes, opts);
  tiles.set(el, tile);
  updateAudio();
  return tile;
}

// A copy of a tile with all its scopes and settings: next to it if there
// is room, otherwise by splitting the tile itself in two.
function duplicateTile(el) {
  const t = tiles.get(el);
  if (t) addTile(t.scopes, { ...t.settings(), near: el });
}

function removeTile(el) {
  const tile = tiles.get(el);
  if (tile) tile.destroy();
  tiles.delete(el);
  grid.removeWidget(el);
  updateAudio();                 // the hole stays: nothing gravitates
  if (tiles.size === 0) showStart();
}

function clearTiles() {
  for (const [el, tile] of tiles) {
    tile.destroy();
    grid.removeWidget(el);
  }
  tiles.clear();
}

// Random mosaic: random tile count, random fitting preset, all tiles
// looping random clips from the same scope.
function randomMosaic(scope) {
  clearTiles();
  paused = false;
  updatePauseBtn();
  const n = 2 + Math.floor(Math.random() * (MAX_TILES - 1));   // 2..6
  const fitting = Object.keys(PRESETS).filter(id => PRESETS[id].fits(n));
  currentPreset = fitting[Math.floor(Math.random() * fitting.length)];
  for (const [x, y, w, h] of layoutFor(n))
    addTile([scope], { rect: { x, y, w, h } });
  closeSidebar();
}

// Tap on a tree item: single full-canvas loop of that scope.
function playScope(scope) {
  clearTiles();
  paused = false;
  currentPreset = "auto";
  updatePauseBtn();
  addTile([scope], { rect: { x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS } });
  closeSidebar();
}

// ---------------------------------------------------------------------
//  Layout presets popover
// ---------------------------------------------------------------------
function renderLayoutPop() {
  const pop = document.getElementById("layout-pop");
  pop.replaceChildren();
  const n = tiles.size;
  for (const [id, p] of Object.entries(PRESETS)) {
    const b = document.createElement("button");
    b.className = "pop-item";
    b.disabled = !p.fits(n);
    b.classList.toggle("active", id === currentPreset);
    b.innerHTML =
      `<span class="material-icons-round">${p.icon}</span><span>${p.label}</span>`;
    b.addEventListener("click", () => {
      currentPreset = id;
      applyLayout();
      // A random preset stays open so you can keep rolling arrangements.
      if (p.random) renderLayoutPop();
      else pop.classList.add("hidden");
    });
    pop.append(b);
  }
}

function toggleLayoutPop() {
  const pop = document.getElementById("layout-pop");
  if (pop.classList.contains("hidden")) renderLayoutPop();
  pop.classList.toggle("hidden");
}

// ---------------------------------------------------------------------
//  Saved mosaics — JSON files on the server, shared by every client.
//  The list is re-fetched whenever the sidebar opens, so changes made on
//  another device show up without any sync machinery.
// ---------------------------------------------------------------------
let mosaics = [];

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Operazione non riuscita");
  return data;
}

async function refreshMosaics() {
  try { mosaics = await api("GET", "/mosaics"); }
  catch (e) { /* server unreachable: keep the last list we had */ }
  renderMosaics();
}

async function mosaicCall(method, m, okMsg) {
  try {
    await api(method, `/mosaics/${encodeURIComponent(m.id)}`, method === "PUT" ? m : null);
    toast(okMsg);
  } catch (e) {
    toast(e.message);
  }
  refreshMosaics();
}

// One-off move of the mosaics an older version kept in this browser's
// localStorage. Ids are fixed (and written back) before uploading, so a
// failed attempt simply retries at the next start without duplicates;
// the local copy is dropped only once every mosaic is on the server.
async function migrateLocal() {
  try {
    const list = JSON.parse(localStorage.getItem(LEGACY_KEY)) || [];
    if (!list.length) return;
    list.forEach((m, i) => {
      m.id ||= newId();
      m.created ||= Date.now() + i;   // keep the old order
    });
    localStorage.setItem(LEGACY_KEY, JSON.stringify(list));
    for (const m of list) await api("PUT", `/mosaics/${encodeURIComponent(m.id)}`, m);
    localStorage.removeItem(LEGACY_KEY);
    toast(list.length === 1 ? "1 mosaico spostato sul server"
                            : `${list.length} mosaici spostati sul server`);
  } catch (e) { /* retry next time */ }
}

function snapshotTiles() {
  // Geometry comes from the DOM so manual drags and resizes are kept.
  return grid.getGridItems().map(el => {
    const r = itemRect(el);
    return { ...tiles.get(el).settings(), x: r.x, y: r.y, w: r.w, h: r.h };
  });
}

function loadMosaic(m) {
  clearTiles();
  paused = false;
  currentPreset = m.preset || "auto";
  updatePauseBtn();
  for (const td of m.tiles.slice(0, MAX_TILES)) {
    // Mosaics saved before mixed tiles existed have a single `scope`.
    addTile(td.scopes || [td.scope || ""], {
      mode: td.mode, duration: td.duration, zoom: td.zoom, ranges: td.ranges,
      rect: { x: td.x, y: td.y, w: td.w, h: td.h },
    });
  }
  closeSidebar();
}

function saveMosaic() {
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  askText({ title: "Salva mosaico", ok: "Salva",
            placeholder: `Mosaico ${mosaics.length + 1}` }, name =>
    mosaicCall("PUT", { id: newId(), name, created: Date.now(),
                        preset: currentPreset, tiles: snapshotTiles() },
               "Mosaico salvato"));
}

// Overwrite a saved mosaic with what is on the canvas right now, so an
// existing mosaic can be tweaked instead of re-created.
function updateMosaic(m) {
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  mosaicCall("PUT", { ...m, preset: currentPreset, tiles: snapshotTiles() },
             "Mosaico aggiornato");
}

function renderMosaics() {
  const box = document.getElementById("mosaics");
  box.replaceChildren();
  if (!mosaics.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Nessun mosaico salvato";
    box.append(p);
    return;
  }
  for (const m of mosaics) {
    const row = document.createElement("div");
    row.className = "mosaic-row";
    row.innerHTML =
      `<span class="material-icons-round">dashboard</span>` +
      `<span class="row-name">${escapeHtml(m.name)}</span>` +
      `<span class="mosaic-count">${m.tiles.length}</span>`;

    row.append(
      rowAction("save", "Aggiorna con il mosaico attuale", () => updateMosaic(m)),
      rowAction("drive_file_rename_outline", "Rinomina", () =>
        askText({ title: "Rinomina mosaico", value: m.name }, name =>
          mosaicCall("PUT", { ...m, name }, "Mosaico rinominato"))),
      rowAction("delete_outline", "Elimina", () =>
        mosaicCall("DELETE", m, "Mosaico eliminato")),
    );
    row.addEventListener("click", () => loadMosaic(m));
    box.append(row);
  }
}

function rowAction(icon, title, onTap) {
  const b = document.createElement("button");
  b.className = "tree-action";
  b.title = title;
  b.innerHTML = `<span class="material-icons-round">${icon}</span>`;
  stopDrag(b);
  b.addEventListener("click", e => { e.stopPropagation(); onTap(); });
  return b;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------
//  Text prompt modal
// ---------------------------------------------------------------------
function askText({ title, value = "", placeholder = "", ok = "Conferma" }, cb) {
  const wrap = document.getElementById("prompt-modal");
  const input = document.getElementById("promptInput");
  document.getElementById("promptTitle").textContent = title;
  document.getElementById("promptOk").textContent = ok;
  input.value = value;
  input.placeholder = placeholder;
  wrap._cb = cb;
  wrap.classList.remove("hidden");
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closePrompt() {
  document.getElementById("prompt-modal").classList.add("hidden");
}

function submitPrompt() {
  const wrap = document.getElementById("prompt-modal");
  const input = document.getElementById("promptInput");
  const value = input.value.trim() || input.placeholder;
  const cb = wrap._cb;
  closePrompt();
  if (value && cb) cb(value);
}

// ---------------------------------------------------------------------
//  Trim dialog: cut every video a tile can play, one at a time, with a
//  big preview. Its single <video> lives in the page and is emptied on
//  close, so it holds no decoder while hidden.
// ---------------------------------------------------------------------
const trim = { tile: null, file: null, track: null };

const trimVideo = () => document.getElementById("trimVideo");

function tileFiles(scopes) {
  return libFiles.filter(f => scopes.some(s => !s || f === s || f.startsWith(s + "/")));
}

function openTrim(tile) {
  trim.tile = tile;
  document.getElementById("trimTitle").textContent = scopeTitle(tile.scopes);
  document.getElementById("trim-modal").classList.remove("hidden");
  const files = tileFiles(tile.scopes);
  trim.file = null;
  selectTrimFile(tile.clip && files.includes(tile.clip.file) ? tile.clip.file : files[0]);
}

function closeTrim() {
  const v = trimVideo();
  v.pause();
  v.removeAttribute("src");
  v.load();
  document.getElementById("trim-modal").classList.add("hidden");
  trim.tile = trim.file = null;
}

// The cut of the selected file, clamped to the preview's duration.
function trimRange() {
  const r = trim.tile?.ranges[trim.file], dur = trimVideo().duration;
  if (!r || !dur) return r || null;
  const a = clamp(r[0], 0, dur), b = clamp(r[1], 0, dur);
  return b - a >= MIN_RANGE ? [a, b] : null;
}

function renderTrimList() {
  const box = document.getElementById("trimList");
  box.replaceChildren();
  const files = tileFiles(trim.tile.scopes);
  if (!files.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Nessun video";
    box.append(p);
  }
  for (const f of files) {
    const row = document.createElement("button");
    row.className = "trim-row" + (f === trim.file ? " active" : "");
    const parts = f.split("/"), name = parts.pop();
    const r = trim.tile.ranges[f];
    row.innerHTML =
      `<span class="row-name">${escapeHtml(name)}` +
      (parts.length ? `<small>${escapeHtml(parts.join(" / "))}</small>` : "") + `</span>` +
      (r ? `<span class="trim-cut">${fmtTime(r[0])} – ${fmtTime(r[1])}</span>` : "");
    row.addEventListener("click", () => selectTrimFile(f));
    box.append(row);
  }
  box.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function selectTrimFile(f) {
  if (f === trim.file) return;
  trim.file = f;
  renderTrimList();
  document.getElementById("trimFile").textContent = f || "";
  const v = trimVideo();
  trim.track.set(0, null, 0);
  paintTrim();
  if (!f) return;
  v.src = `/video/${encodePath(f)}`;
  v.load();
}

function paintTrim() {
  const v = trimVideo(), r = trimRange();
  trim.track.set(v.duration || 0, r, v.currentTime);
  document.getElementById("trimTime").textContent = trim.track.label();
  document.getElementById("trimReset").style.visibility = r ? "" : "hidden";
}

// Commit a cut to the tile and play the preview from the cut point.
function commitTrim(range, which = 0) {
  const v = trimVideo();
  trim.tile.setRange(trim.file, range, v.duration, which);
  const [a, b] = trimRange() || [0, v.duration];
  v.currentTime = which === 1 ? Math.max(a, b - 3) : a;
  v.play().catch(() => {});
  renderTrimList();
  paintTrim();
}

function initTrim() {
  const v = trimVideo();
  trim.track = new Track({
    onPreview: t => {
      previewSeek(v, t);
      document.getElementById("trimTime").textContent = trim.track.label();
    },
    onSeek: t => { v.currentTime = t; },
    onRange: (r, which) => commitTrim(r, which),
  });
  document.getElementById("trimTrack").replaceWith(trim.track.el);
  v.addEventListener("loadedmetadata", () => {
    v.currentTime = trimRange()?.[0] || 0;
    v.play().catch(() => {});
    paintTrim();
  });
  // The preview loops the cut, so you see exactly what the tile will play.
  v.addEventListener("timeupdate", () => {
    const r = trimRange();
    if (r && !trim.track.drag && (v.currentTime >= r[1] || v.currentTime < r[0] - 0.5))
      v.currentTime = r[0];
    if (!trim.track.drag) paintTrim();
  });
  v.addEventListener("click", () => v.paused ? v.play().catch(() => {}) : v.pause());
  document.getElementById("trimReset").addEventListener("click", () => commitTrim(null));
  document.getElementById("trimClose").addEventListener("click", closeTrim);
  document.getElementById("trim-modal").addEventListener("click", e => {
    if (e.target.id === "trim-modal") closeTrim();
  });
}

// ---------------------------------------------------------------------
//  Global controls
// ---------------------------------------------------------------------
function nextAll() {
  for (const t of tiles.values()) t.advance();
}

function updatePauseBtn() {
  document.querySelector("#pauseBtn .material-icons-round").textContent =
    paused ? "play_arrow" : "pause";
}

function togglePause() {
  paused = !paused;
  updatePauseBtn();
  for (const t of tiles.values()) t.setPaused(paused);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

function showStart() { document.getElementById("start-screen").classList.remove("hidden"); }
function hideStart() { document.getElementById("start-screen").classList.add("hidden"); }
function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); }

// Files were moved or deleted (outside the app) while a tile was playing.
// Say so and reload the tree; playback recovers on its own with the next
// clip.
let troubleAt = 0;
function libraryTrouble() {
  if (Date.now() - troubleAt < 15000) return;
  troubleAt = Date.now();
  toast("Ohoh, non trovo il video — aggiorno la libreria");
  loadTree();
}

// ---------------------------------------------------------------------
//  Library tree
// ---------------------------------------------------------------------
async function loadTree() {
  let data;
  try { data = await (await fetch("/tree")).json(); }
  catch (e) { return; }
  libFiles = [];
  const collect = ns => ns.forEach(n => n.type === "dir" ? collect(n.children) : libFiles.push(n.path));
  collect(data);
  const lib = document.getElementById("library");
  lib.replaceChildren();
  lib.append(treeRow({ icon: "home", name: scopeLabel(""), path: "", kind: "root" }));
  renderNodes(data, lib, 0);
}

function renderNodes(nodes, parent, depth) {
  for (const n of nodes) {
    if (n.type === "dir") {
      const row = treeRow({ icon: "folder", name: n.name, path: n.path,
                            kind: "dir", depth });
      const caret = document.createElement("button");
      caret.className = "caret";
      caret.innerHTML = '<span class="material-icons-round">chevron_right</span>';
      row.prepend(caret);

      const kids = document.createElement("div");
      kids.className = "children";
      renderNodes(n.children, kids, depth + 1);
      if (openDirs.has(n.path)) {
        kids.classList.add("open");
        caret.classList.add("open");
      }

      caret.addEventListener("click", e => {
        e.stopPropagation();
        const open = kids.classList.toggle("open");
        caret.classList.toggle("open", open);
        open ? openDirs.add(n.path) : openDirs.delete(n.path);
      });
      for (const ev of ["pointerdown", "touchstart"])
        caret.addEventListener(ev, e => e.stopPropagation());

      parent.append(row, kids);
    } else {
      parent.append(treeRow({ icon: "movie", name: n.name, path: n.path,
                              kind: "file", depth }));
    }
  }
}

function treeRow({ icon, name, path, kind, depth = 0 }) {
  const row = document.createElement("div");
  row.className = "tree-row" + (kind === "root" ? " root" : "");
  row.dataset.path = path;
  row.dataset.kind = kind;
  row.style.paddingLeft =
    `${kind === "root" ? 12 : 12 + depth * 16 + (kind === "file" ? 26 : 0)}px`;
  row.innerHTML =
    `<span class="material-icons-round">${icon}</span>` +
    `<span class="row-name">${escapeHtml(name)}</span>`;
  if (kind !== "file")
    row.append(rowAction("auto_awesome_mosaic", "Mosaico casuale",
                         () => randomMosaic(path)));

  row.addEventListener("click", () => {
    if (row._dragged) { row._dragged = false; return; }
    playScope(path);
  });
  makeDraggable(row, path);
  return row;
}

// ---------------------------------------------------------------------
//  Long-press drag onto the canvas: over a tile it mixes the entry into
//  that tile; over empty space or the fixed "new tile" zone it adds a
//  tile (the zone works even when the canvas is full). Dropping back on
//  the sidebar does nothing.
// ---------------------------------------------------------------------
function makeDraggable(row, scope) {
  let pressT = null, dragging = false, startX = 0, startY = 0, target = null;
  const ghost = document.getElementById("drag-ghost");
  const zone = document.getElementById("new-zone");

  // While an actual drag is running, block native touch scrolling.
  row.addEventListener("touchmove", e => { if (dragging) e.preventDefault(); },
    { passive: false });

  row.addEventListener("pointerdown", e => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY;
    pressT = setTimeout(() => {
      dragging = true;
      row._dragged = true;
      row.classList.add("dragging");
      try { row.setPointerCapture(e.pointerId); } catch (err) {}
      ghost.textContent = scopeLabel(scope);
      ghost.classList.remove("hidden");
      moveGhost(e.clientX, e.clientY);
      zone.classList.add("visible");
      navigator.vibrate?.(30);
    }, PRESS_MS);
  });

  row.addEventListener("pointermove", e => {
    if (dragging) {
      moveGhost(e.clientX, e.clientY);
      setTarget(dropAt(e.clientX, e.clientY));
    } else if (pressT &&
        Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_SLOP) {
      clearTimeout(pressT); pressT = null;   // it's a scroll / swipe
    }
  });

  const finish = e => {
    clearTimeout(pressT); pressT = null;
    if (!dragging) return;
    dragging = false;
    row.classList.remove("dragging");
    ghost.classList.add("hidden");
    zone.classList.remove("visible");
    setTarget(null);
    if (e.type === "pointerup" && !overSidebar(e.clientX)) {
      const drop = dropAt(e.clientX, e.clientY);
      if (drop && drop !== zone) tiles.get(drop).addScope(scope);
      else addTile([scope]);
    }
    // keep _dragged=true so the trailing click doesn't also play
    setTimeout(() => { row._dragged = false; }, 300);
  };
  row.addEventListener("pointerup", finish);
  row.addEventListener("pointercancel", finish);

  function setTarget(el) {
    if (target === el) return;
    target?.classList.remove("drop-target");
    target = el;
    target?.classList.add("drop-target");
  }
  // The zone, the tile under the pointer, or null (empty space / sidebar).
  function dropAt(x, y) {
    if (overSidebar(x)) return null;
    const z = zone.getBoundingClientRect();
    if (x >= z.left && x <= z.right && y >= z.top && y <= z.bottom) return zone;
    const hit = document.elementFromPoint(x, y);
    const item = hit && hit.closest ? hit.closest(".grid-stack-item") : null;
    return item && tiles.has(item) ? item : null;
  }
  function moveGhost(x, y) {
    ghost.style.transform = `translate(${x + 14}px, ${y - 20}px)`;
  }
  function overSidebar(x) {
    const sb = document.getElementById("sidebar");
    return sb.classList.contains("open") && x < sb.getBoundingClientRect().right;
  }
}

// ---------------------------------------------------------------------
//  Topbar auto-hide
// ---------------------------------------------------------------------
let hideT = null;
function pokeTopbar() {
  document.getElementById("topbar").classList.remove("hidden");
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    if (!document.getElementById("sidebar").classList.contains("open")) {
      document.getElementById("topbar").classList.add("hidden");
      document.getElementById("layout-pop").classList.add("hidden");
    }
  }, 3500);
}

// ---------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------
window.addEventListener("load", () => {
  initGrid();
  initTrim();
  loadTree();
  migrateLocal().then(refreshMosaics);

  document.getElementById("start-screen").addEventListener("click", () =>
    playScope(""));
  document.getElementById("menuBtn").addEventListener("click", () => {
    if (document.getElementById("sidebar").classList.toggle("open")) refreshMosaics();
  });
  document.getElementById("closeSidebar").addEventListener("click", closeSidebar);
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("nextBtn").addEventListener("click", nextAll);
  document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.getElementById("layoutBtn").addEventListener("click", e => {
    e.stopPropagation();
    toggleLayoutPop();
  });
  document.getElementById("saveMosaicBtn").addEventListener("click", saveMosaic);
  document.getElementById("promptCancel").addEventListener("click", closePrompt);
  document.getElementById("promptOk").addEventListener("click", submitPrompt);
  document.getElementById("promptInput").addEventListener("keydown", e => {
    if (e.key === "Enter") submitPrompt();
    if (e.key === "Escape") closePrompt();
  });
  document.getElementById("prompt-modal").addEventListener("click", e => {
    if (e.target.id === "prompt-modal") closePrompt();
  });

  // Close the layout popover on any outside press.
  document.addEventListener("pointerdown", e => {
    const pop = document.getElementById("layout-pop");
    if (!pop.classList.contains("hidden") &&
        !pop.contains(e.target) &&
        !document.getElementById("layoutBtn").contains(e.target))
      pop.classList.add("hidden");
  });

  document.addEventListener("pointermove", pokeTopbar);
  document.addEventListener("pointerdown", pokeTopbar);
  pokeTopbar();
});
