"use strict";

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
