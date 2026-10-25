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
let mosaicAudio = false;       // mosaic tiles play sound too (per device)
const tiles = new Map();       // gridstack item el -> Tile
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
    this.skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);  // files left out
    this.volume = typeof opts.volume === "number" ? clamp(opts.volume, 0, 1) : 1;
    this.gen = 0;              // bumped to cancel stale async work
    this.pre = 0;              // bumped to cancel a stale prefetch
    this.loading = false;      // advance() is loading on the hidden element
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
    this.scopeEl.title = "Modifica il tassello";
    this.scopeEl.innerHTML = '<span class="material-icons-round">tune</span><span></span>';
    this.scopeText = this.scopeEl.lastChild;
    stopDrag(this.scopeEl);
    this.scopeEl.addEventListener("click", e => { e.stopPropagation(); openEditor(this); });
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
    this.root.addEventListener("click", () => {
      if (!this.root.parentElement?._dragged) this.showOverlay();
    });
    this.updateControls();
    this.applyZoom();
    this.advance();
  }

  makeVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    noOverlays(v);
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
    this.root.parentElement?.classList.add("active");   // resize corners
    this.renderTimeline();
    clearTimeout(this.overlayT);
    this.overlayT = setTimeout(() => {
      this.overlay.classList.remove("visible");
      this.root.parentElement?.classList.remove("active");
      this.durPanel.classList.remove("visible");
    }, 5000);
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

  // Title: the scope chip (tap → tile editor) and the file playing now.
  // A single-file tile shows the file name in the chip only.
  updateTitle(clip) {
    const parts = clip.file.split("/");
    const name = parts.pop();
    const whole = this.scopes.length === 1 && !this.scopes[0];
    this.scopeText.textContent = this.isFile(clip) ? name
      : whole ? (parts.length ? parts[parts.length - 1] : "Libreria")
      : scopeTitle(this.scopes);
    this.fileEl.textContent = name;
    this.fileEl.style.display = this.isFile(clip) ? "none" : "";
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

  // Store the cut of one file (null or the whole file = no cut).
  setRange(file, range, dur, which = 0) {
    remember("Taglio");
    if (range && (range[0] > 0.1 || range[1] < dur - 0.1))
      this.ranges[file] = [Math.round(range[0] * 100) / 100, Math.round(range[1] * 100) / 100];
    else
      delete this.ranges[file];
    // A prefetched clip of the same file may now start outside the cut.
    if (this.next?.clip.file === file) this.refetch();
    this.recut(file, which);
  }

  // If `file` is on screen, re-cut its window in place: same element, no
  // reload. `which` = the handle just moved, so ending on the end handle
  // lets you hear the cut point.
  recut(file, which = 0) {
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

  // Drop the prefetched clip (it may no longer fit) and fetch another.
  refetch() {
    this.next = null;
    this.pre++;
    if (this.clip && !this.loading && !(this.mode === "full" && this.isFile(this.clip)))
      this.prefetch();
  }

  // Can this tile still play `file`? (inside a scope and not left out)
  plays(file) {
    return !this.skip.has(file) &&
      this.scopes.some(s => !s || file === s || file.startsWith(s + "/"));
  }

  // Scope / file list changed: move on if what is on screen is gone.
  rescoped() {
    if (!this.clip || !this.plays(this.clip.file)) {
      this.next = null;
      this.advance();
    } else {
      this.refetch();
    }
    this.updateTitle(this.clip || { file: "" });
  }

  removeScope(i) {
    if (this.scopes.length < 2) return;
    remember("Togli dal mix");
    this.scopes.splice(i, 1);
    this.rescoped();
  }

  toggleSkip(file) {
    remember(this.skip.has(file) ? "Includi video" : "Escludi video");
    if (!this.skip.delete(file)) this.skip.add(file);
    this.rescoped();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    for (const el of this.videos) el.volume = this.volume;
  }

  // Undo of settings that need no reload: zoom, volume, cuts.
  retune(td) {
    this.zoom = ZOOMS.some(z => z.id === td.zoom) ? td.zoom : "fill";
    this.setVolume(typeof td.volume === "number" ? td.volume : 1);
    this.ranges = cleanRanges(td.ranges);
    this.updateControls();
    this.refreshCrop();
    if (this.clip) this.recut(this.clip.file);
    if (this.next) this.refetch();
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
    this.skip.delete(scope);
    this.next = null;
    this.advance();
    toast(`Mescolati: ${scopeTitle(this.scopes)}`);
  }

  // Another tile was dropped on this one: take its scopes, plus its cuts
  // and left-out files where they don't contradict ours.
  mergeFrom(o) {
    const had = f => this.plays(f);
    for (const f of o.skip) if (!had(f)) this.skip.add(f);
    for (const [f, r] of Object.entries(o.ranges)) if (!this.ranges[f]) this.ranges[f] = r;
    this.scopes.push(...o.scopes);
    this.next = null;
    this.advance();
    toast(`Mescolati: ${scopeTitle(this.scopes)}`);
  }

  // Everything needed to rebuild this tile elsewhere (duplicate, mosaic).
  settings() {
    return { scopes: [...this.scopes], skip: [...this.skip], mode: this.mode,
             duration: this.duration, zoom: this.zoom, volume: this.volume,
             ranges: { ...this.ranges } };
  }

  toggleMode() {
    remember("Modalità");
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
    remember("Durata clip");
    this.duration = d;
    this.durPanel.classList.remove("visible");
    this.updateControls();
    this.showOverlay();
    this.next = null;          // applies from the next clip
    this.advance();
  }

  cycleZoom() {
    remember("Zoom");
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
    for (const f of this.skip) params.append("skip", f);
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
      el._done?.(false);                 // a previous load on el settles as stale
      let settled = false;
      const done = el._done = (ok) => {
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
      this.loading = false;
    } else {
      this.spinner.classList.add("visible");
      this.loading = true;
      while (true) {
        try {
          clip = await this.fetchClip();
          el = this.videos[1 - this.active];
          await this.prepare(el, clip);
          break;
        } catch (e) {
          if (gen !== this.gen) return;
          if (e.message === "stale") { this.loading = false; return; }
          if (++fails >= 2) libraryTrouble();
          await new Promise(r => setTimeout(r, 2000));
          if (gen !== this.gen) return;
        }
      }
    }
    if (gen !== this.gen) return;
    this.loading = false;
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

    el.muted = !audible();
    el.volume = this.volume;
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
    const gen = this.gen, pre = ++this.pre;
    try {
      const clip = await this.fetchClip();
      if (gen !== this.gen || pre !== this.pre) return;
      const el = this.videos[1 - this.active];
      await this.prepare(el, clip);
      if (gen === this.gen && pre === this.pre) this.next = { clip, el };
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
  // already counts itself. Proxies carry audio, so this holds with mosaic
  // audio on as well.
  const many = grid.getGridItems().length > 1;
  return `/video/${encodePath(file)}${many ? "?q=low" : ""}`;
}

// The tablet's browser draws picture-in-picture and cast buttons on top of
// videos, where they steal the taps meant for our controls. Turn them off.
function noOverlays(v) {
  v.disablePictureInPicture = true;
  v.disableRemotePlayback = true;
  v.setAttribute("disablepictureinpicture", "");
  v.setAttribute("disableremoteplayback", "");
  v.setAttribute("controlslist", "nodownload nofullscreen noremoteplayback noplaybackrate");
}

// Range sliders paint their filled part from --fill (0–100%).
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty("--fill", ((el.value - min) / (max - min)) * 100 + "%");
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
    // Our own move and resize (makeMovable / makeResizable): GridStack's
    // push neighbours away. GridStack only lays the tiles out.
    disableDrag: true,
    disableResize: true,
  }, "#grid");
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

function occupancy(rects = grid.getGridItems().map(itemRect)) {
  const g = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(false));
  for (const r of rects) {
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

// A single tile always has sound; a mosaic only when the user asked.
const audible = () => tiles.size === 1 || mosaicAudio;

function updateAudio() {
  for (const t of tiles.values())
    t.videos[t.active].muted = !audible();
}

function toggleAudio() {
  mosaicAudio = !mosaicAudio;
  try { localStorage.setItem("kiosk.audio", mosaicAudio ? "1" : ""); } catch (e) {}
  updateAudioBtn();
  updateAudio();
  toast(mosaicAudio ? "Audio del mosaico attivo" : "Audio del mosaico spento");
}

function updateAudioBtn() {
  const b = document.getElementById("audioBtn");
  b.querySelector("span").textContent = mosaicAudio ? "volume_up" : "volume_off";
  b.classList.toggle("on", mosaicAudio);
  b.title = mosaicAudio ? "Audio del mosaico: attivo" : "Audio del mosaico: spento";
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
  makeResizable(el);
  makeMovable(el);
  const tile = new Tile(el.querySelector(".grid-stack-item-content"), scopes, opts);
  tiles.set(el, tile);
  updateAudio();
  return tile;
}

// ---------------------------------------------------------------------
//  Resize from any corner (our handles, not GridStack's, which pushes the
//  neighbours away). Each moving edge behaves like a splitter:
//   - growing: the neighbours the tile eats into shrink on that side,
//     never below MIN_CELLS (the tile stops instead);
//   - shrinking: the neighbours that touched that edge grow to fill the
//     space it leaves, when they can do so without hitting another tile.
//  Everything is computed from the geometry captured at pointerdown, so
//  going back and forth within one gesture is lossless.
// ---------------------------------------------------------------------
const MIN_CELLS = 1;
const CORNERS = ["nw", "ne", "sw", "se"];

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = r => r.w * r.h;

// Tile `o` (from `base`) wants rect R. Returns R (clamped if a neighbour
// can't give way) and the new rect of every neighbour that changes.
function fitResize(o, R, base) {
  R = { ...R };
  for (let pass = 0; pass < 8; pass++) {
    const out = new Map();
    let blocked = null;
    for (const n of base) {
      if (n.el === o.el || !overlaps(n, R)) continue;
      // Which side of the original tile the neighbour sits on decides
      // which of its edges gives way.
      const opts = [];
      if (n.x >= o.x + o.w) opts.push(["r", { x: R.x + R.w, y: n.y, w: n.x + n.w - R.x - R.w, h: n.h }]);
      if (n.x + n.w <= o.x) opts.push(["l", { x: n.x, y: n.y, w: R.x - n.x, h: n.h }]);
      if (n.y >= o.y + o.h) opts.push(["b", { x: n.x, y: R.y + R.h, w: n.w, h: n.y + n.h - R.y - R.h }]);
      if (n.y + n.h <= o.y) opts.push(["t", { x: n.x, y: n.y, w: n.w, h: R.y - n.y }]);
      const ok = opts.filter(([, r]) => r.w >= MIN_CELLS && r.h >= MIN_CELLS);
      if (ok.length) {
        out.set(n.el, ok.sort((a, b) => area(b[1]) - area(a[1]))[0][1]);   // cheapest side
      } else {
        blocked = [n, opts[0]?.[0]];
        break;
      }
    }
    if (!blocked) {
      fillGaps(o, R, base, out);
      return { R, out };
    }
    // Stop the tile where the neighbour keeps MIN_CELLS, and try again.
    const [n, side] = blocked;
    if (side === "r") R.w = n.x + n.w - MIN_CELLS - R.x;
    else if (side === "l") { const x = n.x + MIN_CELLS; R.w -= x - R.x; R.x = x; }
    else if (side === "b") R.h = n.y + n.h - MIN_CELLS - R.y;
    else if (side === "t") { const y = n.y + MIN_CELLS; R.h -= y - R.y; R.y = y; }
    else break;
  }
  return { R: { x: o.x, y: o.y, w: o.w, h: o.h }, out: new Map() };
}

// The tile shrank on some side: neighbours that touched that edge grow
// into the freed strip, if nothing else is in the way.
function fillGaps(o, R, base, out) {
  const cur = n => out.get(n.el) || n;
  const spanY = n => n.y < o.y + o.h && o.y < n.y + n.h;
  const spanX = n => n.x < o.x + o.w && o.x < n.x + n.w;
  const grow = [
    [R.x + R.w < o.x + o.w, n => spanY(n) && n.x === o.x + o.w,
      n => ({ x: R.x + R.w, y: n.y, w: n.x + n.w - R.x - R.w, h: n.h })],
    [R.x > o.x, n => spanY(n) && n.x + n.w === o.x,
      n => ({ x: n.x, y: n.y, w: R.x - n.x, h: n.h })],
    [R.y + R.h < o.y + o.h, n => spanX(n) && n.y === o.y + o.h,
      n => ({ x: n.x, y: R.y + R.h, w: n.w, h: n.y + n.h - R.y - R.h })],
    [R.y > o.y, n => spanX(n) && n.y + n.h === o.y,
      n => ({ x: n.x, y: n.y, w: n.w, h: R.y - n.y })],
  ];
  for (const [shrank, touches, grown] of grow) {
    if (!shrank) continue;
    for (const n of base) {
      if (n.el === o.el || out.has(n.el) || !touches(n)) continue;
      const r = grown(n);
      const clash = overlaps(r, R) || base.some(m =>
        m.el !== o.el && m.el !== n.el && overlaps(r, cur(m)));
      if (!clash) out.set(n.el, r);
    }
  }
}

// Apply rects without two items ever overlapping (GridStack would push
// one away): first everything shrinks to what its old and new rect
// share, then everything grows to its new rect.
function applyRects(rects) {
  const inter = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
  };
  const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const todo = [...rects].map(([el, r]) => [el, itemRect(el), r]).filter(([, c, r]) => !same(c, r));
  for (const [el, c, r] of todo) {
    const i = inter(c, r);
    if (i.w > 0 && i.h > 0 && !same(i, c)) grid.update(el, i);
  }
  for (const [el, , r] of todo) grid.update(el, { x: r.x, y: r.y, w: r.w, h: r.h });
}

function makeResizable(el) {
  let g = null;                // { x, y, corner, o, base, before, last }
  for (const corner of CORNERS) {
    const handle = document.createElement("div");
    handle.className = "tile-resize " + corner;
    stopDrag(handle);
    el.append(handle);

    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      const base = grid.getGridItems().map(itemRect);
      g = { x: e.clientX, y: e.clientY, corner, o: base.find(b => b.el === el), base,
            before: canvasSnap(), last: "" };
    });
    handle.addEventListener("pointermove", e => {
      if (!g) return;
      tiles.get(el)?.showOverlay();          // keep the corners visible
      const G = gridGeom(), o = g.o;
      const dx = Math.round((e.clientX - g.x) / G.cw), dy = Math.round((e.clientY - g.y) / G.ch);
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (g.corner.includes("w")) x0 = clamp(x0 + dx, 0, x1 - 1);
      else x1 = clamp(x1 + dx, x0 + 1, GRID_COLS);
      if (g.corner.includes("n")) y0 = clamp(y0 + dy, 0, y1 - 1);
      else y1 = clamp(y1 + dy, y0 + 1, GRID_ROWS);
      const { R, out } = fitResize(o, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, g.base);
      const key = JSON.stringify([R, [...out.values()]]);
      if (key === g.last) return;
      g.last = key;
      const rects = new Map(g.base.map(b => [b.el, out.get(b.el) || b]));
      rects.set(el, R);
      applyRects(rects);
    });
    const end = () => {
      if (!g) return;
      if (JSON.stringify(g.before) !== JSON.stringify(canvasSnap()))
        remember("Ridimensiona", g.before);
      g = null;
      reZoom();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
}

// A copy of a tile with all its scopes and settings: next to it if there
// is room, otherwise by splitting the tile itself in two.
function duplicateTile(el) {
  const t = tiles.get(el);
  if (!t || tiles.size >= MAX_TILES) {
    toast(`Massimo ${MAX_TILES} video nel mosaico`);
    return;
  }
  remember("Duplica");
  addTile(t.scopes, { ...t.settings(), near: el });
  reZoom();
}

function removeTile(el) {
  remember("Rimuovi tassello");
  dropTile(el);
}

// Remove a tile without an undo entry (the caller took care of it).
function dropTile(el) {
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
  Smart.stop(false);         // new content: the regia makes way
  if (tiles.size) remember("Mosaico casuale");
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
  Smart.stop(false);         // new content: the regia makes way
  if (tiles.size) remember("Riproduci");
  clearTiles();
  paused = false;
  currentPreset = "auto";
  updatePauseBtn();
  addTile([scope], { rect: { x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS } });
  closeSidebar();
}

// ---------------------------------------------------------------------
//  Undo: a short stack of "how to go back" closures. Canvas edits keep a
//  snapshot of the whole canvas taken just before the change (a few
//  hundred bytes); saved-mosaic edits keep the previous server copy and
//  write it back. Nothing more clever than that.
// ---------------------------------------------------------------------
const UNDO_MAX = 25;
const undoStack = [];

function pushUndo(label, undo) {
  undoStack.push({ label, undo });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  updateUndoBtn();
}

const canvasSnap = () => ({ preset: currentPreset, tiles: snapshotTiles() });

// Call BEFORE changing the canvas (or pass a snapshot taken earlier).
function remember(label, snap = canvasSnap()) {
  pushUndo(label, () => restoreCanvas(snap));
}

function undo() {
  const u = undoStack.pop();
  updateUndoBtn();
  if (!u) return;
  u.undo();
  toast(`Annullato: ${u.label}`);
}

function updateUndoBtn() {
  document.getElementById("undoBtn").disabled = !undoStack.length;
}

// Put the canvas back as `snap` describes it, disturbing as little as
// possible. Tiles are matched by position in the list (= creation order):
// extra trailing tiles go away (undoing an add / duplicate), a tile with
// the same content is adjusted in place and keeps playing (a cut, a zoom,
// a move), a tile whose content changed is rebuilt, missing ones are added.
function restoreCanvas(snap) {
  currentPreset = snap.preset || "auto";
  const want = snap.tiles.slice(0, MAX_TILES);
  const items = grid.getGridItems();
  while (items.length > want.length) {
    const el = items.pop();
    tiles.get(el)?.destroy();
    tiles.delete(el);
    grid.removeWidget(el);
  }
  const key = td => JSON.stringify([td.scopes, td.skip, td.mode, td.duration]);
  const rect = td => ({ x: td.x, y: td.y, w: td.w, h: td.h });
  grid.batchUpdate();
  // Twice: a tile moved first may be pushed by one not yet moved back.
  for (let pass = 0; pass < 2; pass++)
    items.forEach((el, i) => grid.update(el, rect(want[i])));
  grid.batchUpdate(false);
  items.forEach((el, i) => {
    const td = want[i], t = tiles.get(el);
    if (key(t.settings()) === key(td)) {
      t.retune(td);
      return;
    }
    t.destroy();
    // A fresh content element: the old one still carries the old tile's
    // listeners.
    const old = el.querySelector(".grid-stack-item-content");
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    tiles.set(el, new Tile(fresh, td.scopes, td));
  });
  for (const td of want.slice(items.length))
    addTile(td.scopes, { ...td, rect: rect(td) });
  if (!tiles.size) showStart();
  updateAudio();
  reZoom();
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
      remember("Layout");
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

async function mosaicCall(method, m, okMsg, undoLabel, undoFn) {
  try {
    await api(method, `/mosaics/${encodeURIComponent(m.id)}`, method === "PUT" ? m : null);
    if (okMsg) toast(okMsg);
    if (undoLabel) pushUndo(undoLabel, undoFn);
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
  Smart.stop(false);         // new content: the regia makes way
  if (tiles.size) remember("Apri mosaico");
  clearTiles();
  paused = false;
  updatePauseBtn();
  // Mosaics saved before mixed tiles existed have a single `scope`.
  restoreCanvas({ preset: m.preset,
                  tiles: m.tiles.map(td => ({ ...td, scopes: td.scopes || [td.scope || ""] })) });
  closeSidebar();
}

function saveMosaic() {
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  askText({ title: "Salva mosaico", ok: "Salva",
            placeholder: `Mosaico ${mosaics.length + 1}` }, name => {
    const m = { id: newId(), name, created: Date.now(),
                preset: currentPreset, tiles: snapshotTiles() };
    mosaicCall("PUT", m, "Mosaico salvato", "Salva mosaico",
               () => mosaicCall("DELETE", m));
  });
}

// Overwrite a saved mosaic with what is on the canvas right now, so an
// existing mosaic can be tweaked instead of re-created.
function updateMosaic(m) {
  if (m.kind === "smart") {
    if (!Smart.active) { toast("Avvia la regia per aggiornarla"); return; }
    mosaicCall("PUT", { ...m, smart: Smart.settings() }, "Regia aggiornata",
               "Aggiorna regia", () => mosaicCall("PUT", m));
    return;
  }
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  mosaicCall("PUT", { ...m, preset: currentPreset, tiles: snapshotTiles() },
             "Mosaico aggiornato", "Aggiorna mosaico", () => mosaicCall("PUT", m));
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
    const smart = m.kind === "smart";
    row.innerHTML =
      `<span class="material-icons-round">${smart ? "auto_awesome" : "dashboard"}</span>` +
      `<span class="row-name">${escapeHtml(m.name)}</span>` +
      `<span class="mosaic-count">${smart ? "regia" : m.tiles.length}</span>`;

    row.append(
      rowAction("save", "Aggiorna con il mosaico attuale", () => updateMosaic(m)),
      rowAction("drive_file_rename_outline", "Rinomina", () =>
        askText({ title: "Rinomina mosaico", value: m.name }, name =>
          mosaicCall("PUT", { ...m, name }, "Mosaico rinominato", "Rinomina mosaico",
                     () => mosaicCall("PUT", m)))),
      rowAction("delete_outline", "Elimina", () =>
        mosaicCall("DELETE", m, "Mosaico eliminato", "Elimina mosaico",
                   () => mosaicCall("PUT", m))),
    );
    row.addEventListener("click", () => smart ? Smart.load(m.smart) : loadMosaic(m));
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
//  Tile editor (tap the scope chip): what a tile plays and how. Remove a
//  scope from the mix, leave single files out, cut each file, set the
//  volume. One big preview <video> lives in the page and is emptied on
//  close, so it holds no decoder while hidden.
// ---------------------------------------------------------------------
const ed = { tile: null, file: null, track: null };
const edVideo = () => document.getElementById("edVideo");

function tileFiles(scopes) {
  return libFiles.filter(f => scopes.some(s => !s || f === s || f.startsWith(s + "/")));
}

function openEditor(tile) {
  ed.tile = tile;
  ed.file = null;
  document.getElementById("edit-modal").classList.remove("hidden");
  renderEditor();
  const files = tileFiles(tile.scopes);
  selectEdFile(tile.clip && files.includes(tile.clip.file) ? tile.clip.file : files[0]);
}

function closeEditor() {
  const v = edVideo();
  v.pause();
  v.removeAttribute("src");
  v.load();
  document.getElementById("edit-modal").classList.add("hidden");
  ed.tile = ed.file = null;
}

function renderEditor() {
  const t = ed.tile;
  document.getElementById("edTitle").textContent = scopeTitle(t.scopes);

  const box = document.getElementById("edScopes");
  box.replaceChildren();
  t.scopes.forEach((s, i) => {
    const chip = document.createElement("span");
    chip.className = "ed-scope";
    const icon = !s ? "home" : libFiles.includes(s) ? "movie" : "folder";
    chip.innerHTML = `<span class="material-icons-round">${icon}</span>` +
                     `<span class="row-name">${escapeHtml(scopeLabel(s))}</span>`;
    if (t.scopes.length > 1)
      chip.append(rowAction("close", "Togli dal mix", () => {
        t.removeScope(i);
        renderEditor();
        if (!tileFiles(t.scopes).includes(ed.file)) selectEdFile(tileFiles(t.scopes)[0]);
      }));
    box.append(chip);
  });

  document.getElementById("edVolume").value = Math.round(t.volume * 100);
  paintRange(document.getElementById("edVolume"));
  document.getElementById("edVolLabel").textContent = Math.round(t.volume * 100) + "%";
  document.getElementById("edAudioOn").classList.toggle("hidden", audible());
  renderEdList();
}

function renderEdList() {
  const t = ed.tile, box = document.getElementById("edList");
  box.replaceChildren();
  const files = tileFiles(t.scopes);
  const off = files.filter(f => t.skip.has(f)).length;
  document.getElementById("edCount").textContent =
    files.length + (off ? ` · ${off} esclusi` : "");
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "ed-row" + (f === ed.file ? " active" : "") + (t.skip.has(f) ? " off" : "");
    const parts = f.split("/"), name = parts.pop();
    const r = t.ranges[f];
    const toggle = rowAction(t.skip.has(f) ? "check_box_outline_blank" : "check_box",
                             t.skip.has(f) ? "Includi" : "Escludi", () => {
      const live = files.filter(x => !t.skip.has(x));
      if (!t.skip.has(f) && live.length <= 1) { toast("Serve almeno un video"); return; }
      t.toggleSkip(f);
      renderEdList();
    });
    const label = document.createElement("span");
    label.className = "row-name";
    label.innerHTML = escapeHtml(name) +
      (parts.length ? `<small>${escapeHtml(parts.join(" / "))}</small>` : "");
    row.append(toggle, label);
    if (r) {
      const cut = document.createElement("span");
      cut.className = "ed-cut";
      cut.textContent = `${fmtTime(r[0])} – ${fmtTime(r[1])}`;
      row.append(cut);
    }
    row.addEventListener("click", () => selectEdFile(f));
    box.append(row);
  }
  box.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function selectEdFile(f) {
  if (f === ed.file) return;
  ed.file = f || null;
  renderEdList();
  document.getElementById("edFile").textContent = f || "";
  const v = edVideo();
  ed.track.set(0, null, 0);
  paintEd();
  if (!f) return;
  v.src = `/video/${encodePath(f)}`;
  v.load();
}

// The cut of the selected file, clamped to the preview's duration.
function edRange() {
  const r = ed.tile?.ranges[ed.file], dur = edVideo().duration;
  if (!r || !dur) return r || null;
  const a = clamp(r[0], 0, dur), b = clamp(r[1], 0, dur);
  return b - a >= MIN_RANGE ? [a, b] : null;
}

function paintEd() {
  const v = edVideo(), r = edRange();
  ed.track.set(v.duration || 0, r, v.currentTime);
  document.getElementById("edTime").textContent = ed.track.label();
  document.getElementById("edReset").style.visibility = r ? "" : "hidden";
}

// Commit a cut to the tile and play the preview from the cut point.
function commitCut(range, which = 0) {
  const v = edVideo();
  ed.tile.setRange(ed.file, range, v.duration, which);
  const [a, b] = edRange() || [0, v.duration];
  v.currentTime = which === 1 ? Math.max(a, b - 3) : a;
  v.play().catch(() => {});
  renderEdList();
  paintEd();
}

function initEditor() {
  const v = edVideo();
  ed.track = new Track({
    onPreview: t => {
      previewSeek(v, t);
      document.getElementById("edTime").textContent = ed.track.label();
    },
    onSeek: t => { v.currentTime = t; },
    onRange: (r, which) => commitCut(r, which),
  });
  document.getElementById("edTrack").replaceWith(ed.track.el);
  v.addEventListener("loadedmetadata", () => {
    v.currentTime = edRange()?.[0] || 0;
    v.play().catch(() => {});
    paintEd();
  });
  // The preview loops the cut, so you see exactly what the tile will play.
  v.addEventListener("timeupdate", () => {
    const r = edRange();
    if (r && !ed.track.drag && (v.currentTime >= r[1] || v.currentTime < r[0] - 0.5))
      v.currentTime = r[0];
    if (!ed.track.drag) paintEd();
  });
  v.addEventListener("click", () => v.paused ? v.play().catch(() => {}) : v.pause());

  const vol = document.getElementById("edVolume");
  vol.addEventListener("pointerdown", () => remember("Volume"));
  vol.addEventListener("input", () => {
    ed.tile.setVolume(vol.value / 100);
    document.getElementById("edVolLabel").textContent = vol.value + "%";
  });
  document.getElementById("edAudioOn").addEventListener("click", () => {
    toggleAudio();
    renderEditor();
  });
  document.getElementById("edReset").addEventListener("click", () => commitCut(null));
  document.getElementById("edClose").addEventListener("click", closeEditor);
  document.getElementById("edit-modal").addEventListener("click", e => {
    if (e.target.id === "edit-modal") closeEditor();
  });
}

// ---------------------------------------------------------------------
//  Global controls
// ---------------------------------------------------------------------
function nextAll() {
  if (Smart.active) { Smart.evolve(); return; }
  for (const t of tiles.values()) t.advance();
}

function updatePauseBtn() {
  document.querySelector("#pauseBtn .material-icons-round").textContent =
    paused ? "play_arrow" : "pause";
}

function togglePause() {
  paused = !paused;
  updatePauseBtn();
  if (Smart.active) Smart.setPaused(paused);
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
// ---------------------------------------------------------------------
//  Themes: all on pure black, picked per device. The tokens live in
//  style.css; index.html applies the saved one before the first paint.
// ---------------------------------------------------------------------
const THEMES = [
  { id: "camera", name: "Camera oscura", font: '"IBM Plex Mono", monospace',
    colors: ["#ff3b2e", "#ffb0a6", "#44120e"] },
  { id: "pellicola", name: "Pellicola", font: '"Space Grotesk", sans-serif',
    colors: ["#ffad1f", "#f4ead6", "#3c3119"] },
  { id: "ghiaccio", name: "Ghiaccio", font: '"Inter", sans-serif',
    colors: ["#3fe0cf", "#e4f4f3", "#1e3a3f"] },
  { id: "vetro", name: "Vetro", font: '"Geist", sans-serif',
    colors: ["linear-gradient(145deg,#fff,#9fd6ff)", "rgba(255,255,255,.5)", "rgba(255,255,255,.2)"] },
  { id: "luci", name: "Luci rosse", font: '"Bodoni Moda", serif',
    colors: ["linear-gradient(90deg,#8a5a44,#f0c9b0)", "#c0392b", "#f3dccf"] },
  { id: "lusso", name: "Lusso", font: '"Cormorant Garamond", serif',
    colors: ["linear-gradient(135deg,#a8822f,#f3dc9f,#a8822f)", "#8a4b22", "#f2e6cf"] },
  { id: "galleria", name: "Galleria", font: '"Archivo", sans-serif',
    colors: ["#ffffff", "#9a9a9a", "#3a3a3a"] },
  { id: "retro", name: "404", font: '"VT323", monospace',
    colors: ["#ffffff", "#9a9a9a", "#1c1c1c"] },
  { id: "rave", name: "Rave", font: '"UnifrakturCook", serif',
    colors: ["#ff1f1f", "linear-gradient(180deg,#fff,#6d6d6d)", "#000000"] },
];

// A theme saved on this device that no longer exists falls back to the default.
const currentTheme = () => {
  const t = document.documentElement.dataset.theme;
  return THEMES.some(x => x.id === t) ? t : "camera";
};

function applyTheme(id) {
  if (id === "camera") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try { localStorage.setItem("kiosk.theme", id); } catch (e) {}
  renderThemeBar();
  syncGlass();
}

// ---------------------------------------------------------------------
//  Adaptive glass ("vetro" only). Like Apple's liquid glass, every
//  floating surface looks at what is under it: over bright footage it
//  turns milky with dark text, over dark footage smoky with white text,
//  and its accent is the complement of the colour behind it. Twice a
//  second each visible surface draws the videos under it into a tiny
//  canvas and averages them (same-origin videos: the canvas stays clean).
//  Areas with no video under them count as the black background.
// ---------------------------------------------------------------------
const GLASS_SURFACES = ["#topbar:not(.hidden)", "#sidebar.open", ".tile-overlay.visible",
                        ".tile-durs.visible", ".pop:not(.hidden)", "#toast:not(.hidden)",
                        ".sm-stagebar.visible", ".sm-pill:not(.hidden)",
                        ".modal-wrap:not(.hidden) > .modal", ".modal-wrap:not(.hidden) > .ed"];
// Light appearance: everything a surface needs to read on bright footage.
const GLASS_LIGHT = {
  "--text": "#0b0b0f", "--text-2": "rgba(0, 0, 0, 0.66)", "--text-3": "rgba(0, 0, 0, 0.42)",
  "--panel": "rgba(255, 255, 255, 0.28)", "--panel-2": "rgba(255, 255, 255, 0.4)",
  "--panel-3": "rgba(255, 255, 255, 0.55)", "--line": "rgba(0, 0, 0, 0.1)",
  "--line-strong": "rgba(0, 0, 0, 0.18)", "--accent-ink": "#ffffff",
  "--accent-fill": "linear-gradient(180deg, rgba(28, 28, 32, 0.92), rgba(48, 48, 56, 0.86))",
  "--surface": "linear-gradient(145deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.36) 45%, rgba(255, 255, 255, 0.5))",
  "--scrim": "linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.5))",
};
let glassT = null, glassCv = null;

function syncGlass() {
  clearInterval(glassT);
  glassT = null;
  if (currentTheme() === "vetro") {
    glassT = setInterval(glassTick, 500);
    glassTick();
  } else {
    for (const el of document.querySelectorAll("[data-glass]")) untint(el);
  }
}

function untint(el) {
  for (const k of [...Object.keys(GLASS_LIGHT), "--accent"]) el.style.removeProperty(k);
  delete el.dataset.glass;
}

// Average colour of what is on screen inside rect R.
function averageUnder(R) {
  glassCv ||= Object.assign(document.createElement("canvas"), { width: 32, height: 18 });
  const ctx = glassCv.getContext("2d", { willReadFrequently: true });
  let r = 0, g = 0, b = 0, covered = 0;
  for (const v of document.querySelectorAll("video.front")) {
    if (!v.videoWidth) continue;
    const E = v.getBoundingClientRect();
    const x0 = Math.max(R.left, E.left), x1 = Math.min(R.right, E.right);
    const y0 = Math.max(R.top, E.top), y1 = Math.min(R.bottom, E.bottom);
    if (x1 <= x0 || y1 <= y0) continue;
    // Where the frame sits inside the element (object-fit cover/contain).
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = (v.style.objectFit === "contain" ? Math.min : Math.max)(E.width / vw, E.height / vh);
    const ox = E.left + (E.width - vw * s) / 2, oy = E.top + (E.height - vh * s) / 2;
    const cx = x => clamp(Math.floor((x - ox) / s / vw * 32), 0, 31);
    const cy = y => clamp(Math.floor((y - oy) / s / vh * 18), 0, 17);
    let px;
    try {
      ctx.drawImage(v, 0, 0, 32, 18);
      const ax = cx(x0), ay = cy(y0);
      px = ctx.getImageData(ax, ay, Math.max(1, cx(x1) - ax + 1), Math.max(1, cy(y1) - ay + 1)).data;
    } catch (e) { continue; }
    let pr = 0, pg = 0, pb = 0;
    for (let i = 0; i < px.length; i += 4) { pr += px[i]; pg += px[i + 1]; pb += px[i + 2]; }
    const n = px.length / 4, area = (x1 - x0) * (y1 - y0);
    r += pr / n * area; g += pg / n * area; b += pb / n * area;
    covered += area;
  }
  const total = Math.max(covered, R.width * R.height);   // the rest is black
  return { r: r / total, g: g / total, b: b / total };
}

function glassTick() {
  if (document.hidden) return;
  const seen = new Set();
  for (const sel of GLASS_SURFACES) {
    for (const el of document.querySelectorAll(sel)) {
      const R = el.getBoundingClientRect();
      if (R.width < 4 || R.height < 4) continue;
      tint(el, averageUnder(R));
      seen.add(el);
    }
  }
  for (const el of document.querySelectorAll("[data-glass]")) if (!seen.has(el)) untint(el);
}

function tint(el, { r, g, b }) {
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Hysteresis: footage hovering around mid-grey doesn't make it flicker.
  const light = el.dataset.glass === "light" ? lum > 0.45 : lum > 0.58;
  el.dataset.glass = light ? "light" : "dark";
  for (const [k, v] of Object.entries(GLASS_LIGHT)) {
    if (light) el.style.setProperty(k, v); else el.style.removeProperty(k);
  }
  // Accent: the complement of the colour behind; neutral footage keeps a
  // calm system blue.
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max ? (max - min) / max : 0;
  let accent;
  if (sat < 0.15) {
    accent = light ? "#0a64d8" : "#9fd6ff";
  } else {
    const d = max - min;
    let h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    h = ((h * 60 + 180) % 360 + 360) % 360;
    accent = `hsl(${Math.round(h)} 85% ${light ? 36 : 72}%)`;
  }
  el.style.setProperty("--accent", accent);
}

function renderThemeBar() {
  const bar = document.getElementById("themeBar");
  bar.replaceChildren();
  for (const t of THEMES) {
    const b = document.createElement("button");
    b.className = "theme-opt" + (t.id === currentTheme() ? " active" : "");
    b.innerHTML = `<span class="theme-swatch">${t.colors.map(c => `<i style="background:${c}"></i>`).join("")}</span>` +
                  `<span style="font-family:${t.font.replace(/"/g, "'")}">${t.name}</span>`;
    b.addEventListener("click", () => applyTheme(t.id));
    bar.append(b);
  }
}

function showTab(id) {
  for (const t of document.querySelectorAll(".sb-tab"))
    t.classList.toggle("active", t.dataset.tab === id);
  document.getElementById("tab-lib").classList.toggle("hidden", id !== "lib");
  document.getElementById("tab-mos").classList.toggle("hidden", id !== "mos");
  document.getElementById("tab-smart").classList.toggle("hidden", id !== "smart");
  if (id === "mos") refreshMosaics();
  if (id === "smart") Smart.pollStatus();
}

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
//  Library: one folder at a time as a grid of cards with a preview frame
//  (/thumb, built once on the server and cached). Tap a folder to open
//  it, a video to play it; the bar above plays / mosaics the open folder.
// ---------------------------------------------------------------------
let libTree = [];              // /tree data
let navPath = "";              // folder shown in the grid ("" = root)

async function loadTree() {
  let data;
  try { data = await (await fetch("/tree")).json(); }
  catch (e) { return; }
  libTree = data;
  libFiles = [];
  const collect = ns => ns.forEach(n => n.type === "dir" ? collect(n.children) : libFiles.push(n.path));
  collect(data);
  renderLibrary();
}

// Children of the folder at `path`, or null if it is gone.
function folderAt(path) {
  let nodes = libTree;
  if (!path) return nodes;
  for (const part of path.split("/")) {
    const d = nodes.find(n => n.type === "dir" && n.name === part);
    if (!d) return null;
    nodes = d.children;
  }
  return nodes;
}

const firstFile = n => n.type === "file" ? n.path
  : n.children.reduce((f, c) => f || firstFile(c), null);
const countFiles = n => n.type === "file" ? 1
  : n.children.reduce((k, c) => k + countFiles(c), 0);
const thumbUrl = file => `/thumb/${encodePath(file)}`;

function openFolder(path) {
  navPath = path;
  renderLibrary();
  document.getElementById("library").scrollTop = 0;
}

function renderLibrary() {
  let nodes = folderAt(navPath);
  if (!nodes) { navPath = ""; nodes = libTree; }

  const crumbs = document.getElementById("crumbs");
  crumbs.replaceChildren();
  const parts = navPath ? navPath.split("/") : [];
  ["", ...parts].forEach((name, i) => {
    const path = parts.slice(0, i).join("/");
    const b = document.createElement("button");
    b.className = "crumb" + (i === parts.length ? " here" : "");
    b.textContent = i ? name : "Tutti i video";
    b.addEventListener("click", () => openFolder(path));
    if (i) crumbs.append(Object.assign(document.createElement("span"),
                                       { className: "crumb-sep", textContent: "/" }));
    crumbs.append(b);
  });
  crumbs.scrollLeft = crumbs.scrollWidth;

  const box = document.getElementById("library");
  box.replaceChildren();
  if (!nodes.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Cartella vuota";
    box.append(p);
  }
  nodes.forEach((n, i) => {
    const card = libCard(n);
    card.style.setProperty("--i", Math.min(i, 24));    // cascade in
    box.append(card);
  });
}

function libCard(n) {
  const dir = n.type === "dir";
  const card = document.createElement("div");
  card.className = "lib-card" + (dir ? " dir" : "");
  const thumb = document.createElement("div");
  thumb.className = "lib-thumb";
  thumb.innerHTML = `<span class="material-icons-round">${dir ? "folder" : "movie"}</span>`;
  const file = firstFile(n);
  if (file) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = thumbUrl(file);
    img.onerror = () => img.remove();
    thumb.append(img);
  }
  if (dir) {
    const badge = document.createElement("span");
    badge.className = "lib-badge";
    badge.innerHTML = `<span class="material-icons-round">folder</span>${countFiles(n)}`;
    thumb.append(badge);
    const play = rowAction("play_arrow", "Riproduci", () => playScope(n.path));
    play.classList.add("lib-play");
    thumb.append(play);
  }
  const name = document.createElement("span");
  name.className = "lib-name";
  name.textContent = n.name;
  card.append(thumb, name);
  card.addEventListener("click", () => {
    if (card._dragged) { card._dragged = false; return; }
    dir ? openFolder(n.path) : playScope(n.path);
  });
  makeDraggable(card, n.path);
  return card;
}

// ---------------------------------------------------------------------
//  Dropping things on the canvas. A drag session shows a ghost and a live
//  preview of where the drop would land, always computed against the
//  geometry the mosaic had when the drag started (the preview itself
//  changes the live DOM):
//   - empty space      → the free area under the finger;
//   - edge of a tile   → that tile shrinks (for real, temporarily) and
//                        the drop takes the half on that side;
//   - middle of a tile → mix into it (also anywhere on a tile once the
//                        mosaic is full).
//  Used both by library entries (long press) and by tiles being moved.
// ---------------------------------------------------------------------
const EDGE = 0.28;             // outer band of a tile that splits instead of mixing

function gridGeom() {
  const g = document.getElementById("grid").getBoundingClientRect();
  return { left: g.left, top: g.top, cw: g.width / GRID_COLS, ch: g.height / GRID_ROWS };
}

// Biggest free rectangle containing cell (cx, cy), roughly square wins.
function freeRectAt(cx, cy, base) {
  const g = occupancy(base);
  if (g[cy][cx]) return null;
  let best = null, bestScore = 0;
  for (let y0 = cy; y0 >= 0 && !g[y0][cx]; y0--) {
    for (let y1 = cy; y1 < GRID_ROWS && !g[y1][cx]; y1++) {
      const free = x => { for (let y = y0; y <= y1; y++) if (g[y][x]) return false; return true; };
      let x0 = cx, x1 = cx;
      while (x0 > 0 && free(x0 - 1)) x0--;
      while (x1 < GRID_COLS - 1 && free(x1 + 1)) x1++;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const score = w * h * Math.min(w, h) / Math.max(w, h);
      if (score > bestScore) { bestScore = score; best = { x: x0, y: y0, w, h }; }
    }
  }
  return best;
}

// {kind: "mix", el} | {kind: "new", rect, split?: {el, rect}} | null
function planDrop(x, y, base) {
  const G = gridGeom();
  const fx = (x - G.left) / G.cw, fy = (y - G.top) / G.ch;
  if (fx < 0 || fy < 0 || fx >= GRID_COLS || fy >= GRID_ROWS) return null;
  const full = base.length >= MAX_TILES;
  const hit = base.find(r => fx >= r.x && fx < r.x + r.w && fy >= r.y && fy < r.y + r.h);
  if (!hit) {
    const rect = full ? null : freeRectAt(Math.floor(fx), Math.floor(fy), base);
    return rect && { kind: "new", rect };
  }
  const mix = { kind: "mix", el: hit.el };
  const u = (fx - hit.x) / hit.w, v = (fy - hit.y) / hit.h;
  if (full || (u > EDGE && u < 1 - EDGE && v > EDGE && v < 1 - EDGE)) return mix;
  // Nearest edge first; a tile too thin to split that way tries the other.
  const sides = [["l", u], ["r", 1 - u], ["t", v], ["b", 1 - v]].sort((a, b) => a[1] - b[1]);
  for (const [side] of sides) {
    const size = side === "l" || side === "r" ? hit.w : hit.h;
    if (size < 2) continue;
    const half = Math.floor(size / 2), rest = size - half;
    const { x: hx, y: hy, w: hw, h: hh } = hit;
    const [rect, keep] = {
      l: [{ x: hx, y: hy, w: half, h: hh }, { x: hx + half, y: hy, w: rest, h: hh }],
      r: [{ x: hx + rest, y: hy, w: half, h: hh }, { x: hx, y: hy, w: rest, h: hh }],
      t: [{ x: hx, y: hy, w: hw, h: half }, { x: hx, y: hy + half, w: hw, h: rest }],
      b: [{ x: hx, y: hy + rest, w: hw, h: half }, { x: hx, y: hy, w: hw, h: rest }],
    }[side];
    return { kind: "new", rect, split: { el: hit.el, rect: keep } };
  }
  return mix;
}

// The "Regia" tab is a drop target too: dropping a library card on it
// adds that folder to the regia.
function overSmartTab(x, y) {
  const r = document.querySelector('.sb-tab[data-tab="smart"]').getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function overSidebar(x) {
  const sb = document.getElementById("sidebar");
  return sb.classList.contains("open") && x < sb.getBoundingClientRect().right;
}

// One drag: `label` for the ghost, `self` = the tile being moved (left
// out of the planning, so its own area counts as free).
function dragSession(label, self = null) {
  const ghost = document.getElementById("drag-ghost");
  const slot = document.getElementById("drop-slot");
  const base = grid.getGridItems().filter(el => el !== self).map(itemRect);
  const before = canvasSnap();
  const smartTab = document.querySelector('.sb-tab[data-tab="smart"]');
  let plan = null;
  ghost.textContent = label;
  ghost.classList.remove("hidden");
  navigator.vibrate?.(30);

  // Show plan `p`, undoing the previous preview first.
  function setPlan(p) {
    const key = q => q && JSON.stringify([q.kind, q.rect, base.findIndex(r => r.el === (q.el || q.split?.el))]);
    if (key(p) === key(plan)) return;
    if (plan?.split) {
      const r = base.find(b => b.el === plan.split.el);
      grid.update(r.el, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
    if (plan?.kind === "mix") plan.el.classList.remove("drop-target");
    plan = p;
    if (p?.split) grid.update(p.split.el, p.split.rect);
    if (p?.kind === "mix") p.el.classList.add("drop-target");
    if (p?.kind === "new") {
      const G = gridGeom(), m = 3;
      slot.style.left = G.left + p.rect.x * G.cw + m + "px";
      slot.style.top = G.top + p.rect.y * G.ch + m + "px";
      slot.style.width = p.rect.w * G.cw - 2 * m + "px";
      slot.style.height = p.rect.h * G.ch - 2 * m + "px";
      slot.classList.remove("hidden");
    } else {
      slot.classList.add("hidden");
    }
    reZoom();
  }

  return {
    before,
    move(x, y) {
      ghost.style.transform = `translate(${x + 14}px, ${y - 20}px)`;
      smartTab.classList.toggle("drop-target", overSmartTab(x, y));
      // While the regia runs the canvas belongs to it: drops add sources.
      if (Smart.active) {
        Smart.hover(!overSidebar(x));
        return;
      }
      setPlan(overSidebar(x) ? null : planDrop(x, y, base));
    },
    // Returns the plan to carry out (its split preview, if any, stays
    // applied), or null after putting everything back.
    end(commit) {
      ghost.classList.add("hidden");
      smartTab.classList.remove("drop-target");
      if (Smart.active) Smart.hover(false);
      const p = commit ? plan : null;
      if (p?.kind === "new") {
        plan = null;
        slot.classList.add("hidden");
      } else {
        setPlan(null);
      }
      return p;
    },
  };
}

// Long-press a library card and drag it onto the canvas.
function makeDraggable(card, scope) {
  let pressT = null, session = null, startX = 0, startY = 0;

  // While an actual drag is running, block native touch scrolling.
  card.addEventListener("touchmove", e => { if (session) e.preventDefault(); },
    { passive: false });

  card.addEventListener("pointerdown", e => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY;
    pressT = setTimeout(() => {
      card._dragged = true;
      card.classList.add("dragging");
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
      session = dragSession(scopeLabel(scope));
      session.move(e.clientX, e.clientY);
    }, PRESS_MS);
  });

  card.addEventListener("pointermove", e => {
    if (session) {
      session.move(e.clientX, e.clientY);
    } else if (pressT &&
        Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_SLOP) {
      clearTimeout(pressT); pressT = null;   // it's a scroll / swipe
    }
  });

  const finish = e => {
    clearTimeout(pressT); pressT = null;
    if (!session) return;
    const s = session;
    session = null;
    card.classList.remove("dragging");
    const up = e.type === "pointerup";
    const toSmart = up && (overSmartTab(e.clientX, e.clientY) ||
                           (Smart.active && !overSidebar(e.clientX)));
    const p = s.end(up && !toSmart);
    if (toSmart) {
      Smart.addSource(scope);
    } else if (p?.kind === "new") {
      remember("Aggiungi video", s.before);
      addTile([scope], { rect: p.rect });
      reZoom();
    } else if (p?.kind === "mix") {
      remember("Mescola", s.before);
      tiles.get(p.el)?.addScope(scope);
    } else if (e.type === "pointerup" && !overSidebar(e.clientX) && tiles.size >= MAX_TILES) {
      toast(`Massimo ${MAX_TILES} video nel mosaico`);
    }
    // keep _dragged=true so the trailing click doesn't also play
    setTimeout(() => { card._dragged = false; }, 300);
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

// Drag a tile around the canvas (GridStack's own drag is off: it pushes
// tiles away). Same landing rules as a library entry: onto another
// tile's middle it mixes the two, elsewhere the tile moves there. A
// press that doesn't travel DRAG_SLOP stays a tap (shows the overlay).
function makeMovable(el) {
  let start = null, session = null;
  el.addEventListener("pointerdown", e => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest(".tile-resize")) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  el.addEventListener("pointermove", e => {
    if (!start) return;
    if (!session) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SLOP) return;
      const t = tiles.get(el);
      if (!t) { start = null; return; }
      try { el.setPointerCapture(start.id); } catch (err) {}
      el.classList.add("lifting");
      session = dragSession(scopeTitle(t.scopes), el);
    }
    session.move(e.clientX, e.clientY);
  });
  const finish = e => {
    start = null;
    if (!session) return;
    const s = session;
    session = null;
    el.classList.remove("lifting");
    el._dragged = true;          // swallow the click that follows
    setTimeout(() => { el._dragged = false; }, 300);
    const p = s.end(e.type === "pointerup");
    if (p?.kind === "new") {
      remember("Sposta tassello", s.before);
      grid.update(el, p.rect);
      reZoom();
    } else if (p?.kind === "mix") {
      remember("Mescola", s.before);
      const target = tiles.get(p.el), t = tiles.get(el);
      dropTile(el);
      target?.mergeFrom(t.settings());
    }
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
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
  try { mosaicAudio = !!localStorage.getItem("kiosk.audio"); } catch (e) {}
  initGrid();
  initEditor();
  initDrawerGestures();
  // Themes that were merged or removed: move this device to their heir.
  const heir = { atelier: "lusso", jetset: "lusso", festa: "camera", boudoir: "camera" };
  const saved = document.documentElement.dataset.theme;
  if (heir[saved]) applyTheme(heir[saved]);
  else if (saved && currentTheme() === "camera") applyTheme("camera");
  document.addEventListener("input", e => { if (e.target.type === "range") paintRange(e.target); });
  syncGlass();
  updateAudioBtn();
  updateUndoBtn();
  loadTree();
  migrateLocal().then(refreshMosaics);

  document.getElementById("start-screen").addEventListener("click", () =>
    playScope(""));
  document.getElementById("menuBtn").addEventListener("click", () => {
    if (document.getElementById("sidebar").classList.toggle("open")) refreshMosaics();
  });
  document.getElementById("closeSidebar").addEventListener("click", closeSidebar);
  document.getElementById("themeBtn").addEventListener("click", () => {
    renderThemeBar();
    document.getElementById("themeBar").classList.toggle("hidden");
  });
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("nextBtn").addEventListener("click", nextAll);
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("audioBtn").addEventListener("click", toggleAudio);
  document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.getElementById("layoutBtn").addEventListener("click", e => {
    e.stopPropagation();
    toggleLayoutPop();
  });
  document.getElementById("saveMosaicBtn").addEventListener("click", saveMosaic);
  for (const tab of document.querySelectorAll(".sb-tab"))
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  document.getElementById("libPlay").addEventListener("click", () => playScope(navPath));
  document.getElementById("libMosaic").addEventListener("click", () => randomMosaic(navPath));
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
