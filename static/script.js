// =====================================================================
//  Video Kiosk — tree + random clip loops + mosaic grid
//
//  Playback: each tile owns TWO <video> elements (double buffer), reused
//  forever. While one plays, the next clip is prefetched on the hidden
//  one, then swapped with a crossfade. No element is ever created per
//  clip, so client memory stays flat.
//
//  Per tile: mode "clips" (random clips, 5..60s) or "full" (whole
//  videos looped), plus a zoom mode (fill / fit / smart crop). Mosaics
//  (tiles + modes + geometry) can be saved to localStorage, reloaded and
//  updated from the sidebar.
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
const STORE_KEY = "kiosk.mosaics";

// Zoom cycle. "smart" crops the black bars baked inside the frame.
const ZOOMS = [
  { id: "fill",  icon: "crop",         title: "Riempi il tassello" },
  { id: "fit",   icon: "fit_screen",   title: "Adatta: nessun taglio" },
  { id: "smart", icon: "auto_fix_high", title: "Zoom automatico: toglie le bande nere" },
];

let grid;                      // GridStack instance
let paused = false;
let currentPreset = "auto";
let manageMode = false;        // sidebar acts as a file manager
const tiles = new Map();       // gridstack item el -> Tile
const openDirs = new Set();    // folder paths expanded in the tree

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
//  Tile: one video slot in the grid, looping its scope
// ---------------------------------------------------------------------
class Tile {
  constructor(contentEl, scope, label, opts = {}) {
    this.scope = scope;        // "" = root, folder path, or file path
    this.label = label;
    this.mode = opts.mode === "full" ? "full" : "clips";
    this.duration = DURATIONS.includes(opts.duration) ? opts.duration : 20;
    this.zoom = ZOOMS.some(z => z.id === opts.zoom) ? opts.zoom : "fill";
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

    // --- overlay controls ---
    this.overlay = document.createElement("div");
    this.overlay.className = "tile-overlay";
    this.title = document.createElement("div");
    this.title.className = "tile-title";
    this.scopeEl = document.createElement("span");
    this.scopeEl.className = "tile-scope";
    this.fileEl = document.createElement("span");
    this.fileEl.className = "tile-file";
    this.fileEl.textContent = label;
    this.title.append(this.scopeEl, this.fileEl);
    this.durBtn = tilePill(() => this.toggleDurPanel());
    this.zoomBtn = tileBtn("crop", () => this.cycleZoom());
    this.modeBtn = tileBtn("shuffle", () => this.toggleMode());
    const skip = tileBtn("skip_next", () => this.advance());
    const close = tileBtn("close", () => removeTile(this.root.parentElement));
    this.overlay.append(this.title, this.durBtn, this.zoomBtn, this.modeBtn, skip, close);

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
      if (!paused && !v.loop && v === this.videos[this.active]) this.advance();
    });
    return v;
  }

  showOverlay() {
    this.overlay.classList.add("visible");
    clearTimeout(this.overlayT);
    this.overlayT = setTimeout(() => {
      this.overlay.classList.remove("visible");
      this.durPanel.classList.remove("visible");
    }, 3000);
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
  }

  // Bottom title: the file being played and, when the tile loops a whole
  // folder, which folder it comes from.
  updateTitle(clip) {
    const parts = clip.file.split("/");
    this.fileEl.textContent = parts.pop();
    const singleFile = this.scope && this.scope === clip.file;
    this.scopeEl.textContent = this.scope
      ? this.label
      : (parts.length ? parts[parts.length - 1] : "Libreria");
    this.scopeEl.style.display = singleFile ? "none" : "";
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
    if (this.scope) params.set("target", this.scope);
    const res = await fetch(`/random?${params}`);
    if (!res.ok) throw new Error("no clips");
    const clip = await res.json();
    if (this.mode === "full") {
      clip.start = 0;
      clip.length = clip.dur;
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

    // A full-mode tile scoped to a single file loops natively: seamless,
    // no timers, no prefetch traffic.
    el.loop = this.mode === "full" && !!this.scope && clip.file === this.scope;

    el.muted = tiles.size > 1;      // audio only in single view
    if (!paused) {
      el.play().catch(() => {});
      this.armTimer();
    }
    this.updateTitle(clip);
    this.refreshCrop();
    if (!el.loop) this.prefetch();
  }

  armTimer() {
    clearTimeout(this.timer);
    const v = this.videos[this.active];
    if (!this.clip || v.loop) return;
    const remaining = (this.clip.start + this.clip.length) - v.currentTime;
    this.timer = setTimeout(() => this.advance(), Math.max(0.3, remaining) * 1000);
  }

  async prefetch() {
    const gen = this.gen;
    try {
      const clip = await this.fetchClip();
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
function videoUrl(file) {
  const path = file.split("/").map(encodeURIComponent).join("/");
  // getGridItems() (not tiles.size) so a tile loading its very first clip
  // already counts itself.
  const many = grid.getGridItems().length > 1;
  return `/video/${path}${many ? "?q=low" : ""}`;
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
// carve half of the biggest tile, so at most ONE existing tile changes
// and none of them ever moves.
function placeNew() {
  const free = freeRect();
  if (free) return free;
  const items = grid.getGridItems().map(itemRect)
    .sort((a, b) => b.w * b.h - a.w * a.h);
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

function addTile(scope, label, opts = {}) {
  if (tiles.size >= MAX_TILES) {
    toast(`Massimo ${MAX_TILES} video nel mosaico`);
    return null;
  }
  hideStart();
  const rect = opts.rect || placeNew();
  if (!rect) {
    toast("Non c'è più spazio: ridimensiona un tassello");
    return null;
  }
  const el = grid.addWidget(rect);
  const tile = new Tile(el.querySelector(".grid-stack-item-content"), scope, label, opts);
  tiles.set(el, tile);
  updateAudio();
  return tile;
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
function randomMosaic(scope, label) {
  clearTiles();
  paused = false;
  updatePauseBtn();
  const n = 2 + Math.floor(Math.random() * (MAX_TILES - 1));   // 2..6
  const fitting = Object.keys(PRESETS).filter(id => PRESETS[id].fits(n));
  currentPreset = fitting[Math.floor(Math.random() * fitting.length)];
  for (const [x, y, w, h] of layoutFor(n))
    addTile(scope, label, { rect: { x, y, w, h } });
  closeSidebar();
}

// Tap on a tree item: single full-canvas loop of that scope.
function playScope(scope, label) {
  clearTiles();
  paused = false;
  currentPreset = "auto";
  updatePauseBtn();
  addTile(scope, label, { rect: { x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS } });
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
//  Saved mosaics (localStorage)
// ---------------------------------------------------------------------
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch (e) { return []; }
}

function saveStore(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
  renderMosaics();
}

function snapshotTiles() {
  // Geometry comes from the DOM so manual drags and resizes are kept.
  return grid.getGridItems().map(el => {
    const t = tiles.get(el), r = itemRect(el);
    return {
      scope: t.scope, label: t.label, mode: t.mode, duration: t.duration,
      zoom: t.zoom, x: r.x, y: r.y, w: r.w, h: r.h,
    };
  });
}

function loadMosaic(m) {
  clearTiles();
  paused = false;
  currentPreset = m.preset || "auto";
  updatePauseBtn();
  for (const td of m.tiles.slice(0, MAX_TILES)) {
    addTile(td.scope, td.label, {
      mode: td.mode, duration: td.duration, zoom: td.zoom,
      rect: { x: td.x, y: td.y, w: td.w, h: td.h },
    });
  }
  closeSidebar();
}

function saveMosaic() {
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  askText({ title: "Salva mosaico", ok: "Salva",
            placeholder: `Mosaico ${loadStore().length + 1}` }, name => {
    const list = loadStore();
    list.push({ id: Date.now().toString(36), name,
                preset: currentPreset, tiles: snapshotTiles() });
    saveStore(list);
    toast("Mosaico salvato");
  });
}

// Overwrite a saved mosaic with what is on the canvas right now, so an
// existing mosaic can be tweaked instead of re-created.
function updateMosaic(m) {
  if (!tiles.size) { toast("Nessun video nel mosaico"); return; }
  const list = loadStore();
  const i = list.findIndex(x => x.id === m.id);
  if (i < 0) return;
  list[i] = { ...list[i], preset: currentPreset, tiles: snapshotTiles() };
  saveStore(list);
  toast("Mosaico aggiornato");
}

function renderMosaics() {
  const box = document.getElementById("mosaics");
  box.replaceChildren();
  const list = loadStore();
  let dirty = false;
  for (const m of list) if (!m.id) { m.id = Math.random().toString(36).slice(2); dirty = true; }
  if (dirty) localStorage.setItem(STORE_KEY, JSON.stringify(list));

  if (!list.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Nessun mosaico salvato";
    box.append(p);
    return;
  }
  for (const m of list) {
    const row = document.createElement("div");
    row.className = "mosaic-row";
    row.innerHTML =
      `<span class="material-icons-round">dashboard</span>` +
      `<span class="row-name">${escapeHtml(m.name)}</span>` +
      `<span class="mosaic-count">${m.tiles.length}</span>`;

    row.append(
      rowAction("save", "Aggiorna con il mosaico attuale", () => updateMosaic(m)),
      rowAction("drive_file_rename_outline", "Rinomina", () =>
        askText({ title: "Rinomina mosaico", value: m.name }, name => {
          const list2 = loadStore();
          const i = list2.findIndex(x => x.id === m.id);
          if (i >= 0) { list2[i].name = name; saveStore(list2); }
        })),
      rowAction("delete_outline", "Elimina", () =>
        saveStore(loadStore().filter(x => x.id !== m.id))),
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

// Another client (or this one, in manage mode) moved files around while a
// tile was playing. Say so and reload the tree; playback recovers on its
// own with the next clip.
let troubleAt = 0;
function libraryTrouble() {
  if (Date.now() - troubleAt < 15000) return;
  troubleAt = Date.now();
  toast("Ohoh, non trovo il video — aggiorno la libreria");
  loadTree();
}

// ---------------------------------------------------------------------
//  Library tree / file manager
// ---------------------------------------------------------------------
async function loadTree() {
  let data;
  try { data = await (await fetch("/tree")).json(); }
  catch (e) { return; }
  const lib = document.getElementById("library");
  lib.replaceChildren();
  lib.append(treeRow({ icon: "home", name: "Tutti i video", path: "", kind: "root" }));
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
  const label = kind === "root" ? "Tutti i video" : name;

  if (manageMode) {
    if (kind !== "file")
      row.append(rowAction("create_new_folder", "Nuova cartella", () =>
        askText({ title: "Nuova cartella", placeholder: "Nome cartella" }, n =>
          fsCall("/fs/folder", { parent: path, name: n }, "Cartella creata"))));
    if (kind !== "root")
      row.append(rowAction("drive_file_rename_outline", "Rinomina", () =>
        askText({ title: "Rinomina", value: name }, n =>
          fsCall("/fs/rename", { path, name: n }, "Rinominato"))));
  } else if (kind !== "file") {
    row.append(rowAction("auto_awesome_mosaic", "Mosaico casuale",
                         () => randomMosaic(path, label)));
  }

  row.addEventListener("click", () => {
    if (row._dragged) { row._dragged = false; return; }
    playScope(path, label);
  });
  makeDraggable(row, path, label);
  return row;
}

async function fsCall(url, body, okMsg) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Operazione non riuscita");
    toast(okMsg);
  } catch (e) {
    toast(e.message || "Operazione non riuscita");
  }
  loadTree();
}

function toggleManage() {
  manageMode = !manageMode;
  document.getElementById("manageBtn").classList.toggle("active", manageMode);
  document.getElementById("libHint").textContent = manageMode
    ? "Riordina: crea cartelle, rinomina, trascina un elemento su una cartella"
    : "Tocca per riprodurre · tieni premuto e trascina per il mosaico o su una cartella per spostare";
  loadTree();
}

function canMove(src, dest) {
  if (!src) return false;                                   // never the root
  if (dest === src || dest.startsWith(src + "/")) return false;
  const parent = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
  return dest !== parent;
}

// ---------------------------------------------------------------------
//  Long-press drag: onto the canvas it adds a tile, onto a folder of the
//  tree it moves the file/folder there.
// ---------------------------------------------------------------------
function makeDraggable(row, scope, label) {
  let pressT = null, dragging = false, startX = 0, startY = 0, target = null;
  const ghost = document.getElementById("drag-ghost");
  const hint = document.getElementById("drop-hint");

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
      ghost.textContent = label;
      ghost.classList.remove("hidden");
      moveGhost(e.clientX, e.clientY);
      hint.classList.add("visible");
      navigator.vibrate?.(30);
    }, PRESS_MS);
  });

  row.addEventListener("pointermove", e => {
    if (dragging) {
      moveGhost(e.clientX, e.clientY);
      const onSidebar = overSidebar(e.clientX);
      hint.classList.toggle("armed", !onSidebar);
      setTarget(onSidebar ? folderRowAt(e.clientX, e.clientY) : null);
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
    hint.classList.remove("visible", "armed");
    const drop = target;
    setTarget(null);
    if (e.type === "pointerup") {
      if (!overSidebar(e.clientX)) addTile(scope, label);
      else if (drop) fsCall("/fs/move", { src: scope, dest: drop.dataset.path },
                            "Spostato");
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
  function folderRowAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const r = hit && hit.closest ? hit.closest(".tree-row") : null;
    if (!r || r === row || r.dataset.kind === "file") return null;
    return canMove(scope, r.dataset.path) ? r : null;
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
  loadTree();
  renderMosaics();

  document.getElementById("start-screen").addEventListener("click", () =>
    playScope("", "Tutti i video"));
  document.getElementById("menuBtn").addEventListener("click", () =>
    document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("closeSidebar").addEventListener("click", closeSidebar);
  document.getElementById("manageBtn").addEventListener("click", toggleManage);
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
