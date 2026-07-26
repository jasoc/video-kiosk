// =====================================================================
//  Video Kiosk — tree + random clip loops + mosaic grid
//
//  Playback: each tile owns TWO <video> elements (double buffer), reused
//  forever. While one plays, the next clip is prefetched on the hidden
//  one, then swapped with a crossfade. No element is ever created per
//  clip, so client memory stays flat.
// =====================================================================

"use strict";

const MAX_TILES = 6;
const GRID_ROWS = 12;
const PRESS_MS = 350;          // long-press before a tree drag starts
const DRAG_SLOP = 12;          // px of movement that cancels a press

let grid;                      // GridStack instance
let clipDuration = 20;
let paused = false;
const tiles = new Map();       // gridstack item el -> Tile

// Preset layouts (x, y, w, h) that fill the 12x12 canvas per tile count.
const LAYOUTS = {
  1: [[0, 0, 12, 12]],
  2: [[0, 0, 6, 12], [6, 0, 6, 12]],
  3: [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 12, 6]],
  4: [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 6, 6], [6, 6, 6, 6]],
  5: [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 6, 6], [6, 6, 6, 6]],
  6: [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 4, 6], [4, 6, 4, 6], [8, 6, 4, 6]],
};

// ---------------------------------------------------------------------
//  Tile: one video slot in the grid, looping random clips of its scope
// ---------------------------------------------------------------------
class Tile {
  constructor(contentEl, scope, label) {
    this.scope = scope;        // "" = root, folder path, or file path
    this.label = label;
    this.gen = 0;              // bumped to cancel stale async work
    this.timer = null;
    this.clip = null;
    this.next = null;          // { clip, el } prefetched and ready
    this.active = 0;
    this.root = contentEl;

    this.videos = [this.makeVideo(), this.makeVideo()];
    this.spinner = document.createElement("div");
    this.spinner.className = "tile-spinner";
    this.spinner.innerHTML = '<span class="material-icons-round">hourglass_top</span>';

    this.overlay = document.createElement("div");
    this.overlay.className = "tile-overlay";
    this.chip = document.createElement("span");
    this.chip.className = "tile-chip";
    this.chip.textContent = label;
    const skip = tileBtn("skip_next", () => this.advance());
    const close = tileBtn("close", () => removeTile(this.root.parentElement));
    this.overlay.append(this.chip, skip, close);

    this.root.append(this.videos[0], this.videos[1], this.spinner, this.overlay);

    this.overlayT = null;
    this.root.addEventListener("click", () => this.showOverlay());
    this.advance();
  }

  makeVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.addEventListener("ended", () => {
      if (!paused && v === this.videos[this.active]) this.advance();
    });
    return v;
  }

  showOverlay() {
    this.overlay.classList.add("visible");
    clearTimeout(this.overlayT);
    this.overlayT = setTimeout(() => this.overlay.classList.remove("visible"), 2500);
  }

  async fetchClip() {
    const params = new URLSearchParams({ duration: clipDuration });
    if (this.scope) params.set("target", this.scope);
    const res = await fetch(`/random?${params}`);
    if (!res.ok) throw new Error("no clips");
    return res.json();
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
      el.src = `/video/${encodeURI(clip.file)}`;
      el.load();
    });
  }

  // Show the next clip: use the prefetched one if ready, otherwise load.
  async advance() {
    const gen = ++this.gen;
    clearTimeout(this.timer);
    let clip, el;

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

    el.muted = tiles.size > 1;      // audio only in single view
    if (!paused) {
      el.play().catch(() => {});
      this.armTimer();
    }
    this.chip.textContent = clip.file.split("/").pop();
    this.prefetch();
  }

  armTimer() {
    clearTimeout(this.timer);
    const v = this.videos[this.active];
    if (!this.clip) return;
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
    for (const v of this.videos) {
      v.pause();
      v.removeAttribute("src");
      v.load();                 // release decoder + buffers
    }
    this.root.replaceChildren();
  }
}

function tileBtn(icon, onTap) {
  const b = document.createElement("button");
  b.className = "tile-btn";
  b.innerHTML = `<span class="material-icons-round">${icon}</span>`;
  // Don't let gridstack treat button presses as a drag start.
  for (const ev of ["pointerdown", "mousedown", "touchstart"])
    b.addEventListener(ev, e => e.stopPropagation());
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
    column: 12,
    maxRow: GRID_ROWS,
    cellHeight: cellHeight(),
    margin: 3,
    float: false,
    animate: true,
    resizable: { handles: "se" },
  }, "#grid");
  window.addEventListener("resize", () => grid.cellHeight(cellHeight()));
}

function applyLayout() {
  const items = grid.getGridItems();
  const layout = LAYOUTS[items.length];
  if (!layout) return;
  grid.batchUpdate();
  items.forEach((el, i) => {
    const [x, y, w, h] = layout[i];
    grid.update(el, { x, y, w, h });
  });
  grid.batchUpdate(false);
}

function updateAudio() {
  const single = tiles.size === 1;
  for (const t of tiles.values())
    t.videos[t.active].muted = !single;
}

function addTile(scope, label) {
  if (tiles.size >= MAX_TILES) {
    toast(`Massimo ${MAX_TILES} video nel mosaico`);
    return null;
  }
  hideStart();
  // Shrink existing tiles to the (n+1)-tile layout first so the new
  // widget's slot is guaranteed to be free (maxRow forbids overflow).
  const layout = LAYOUTS[tiles.size + 1];
  const items = grid.getGridItems();
  grid.batchUpdate();
  items.forEach((itemEl, i) => {
    const [x, y, w, h] = layout[i];
    grid.update(itemEl, { x, y, w, h });
  });
  grid.batchUpdate(false);
  const [x, y, w, h] = layout[items.length];
  const el = grid.addWidget({ x, y, w, h });
  const tile = new Tile(el.querySelector(".grid-stack-item-content"), scope, label);
  tiles.set(el, tile);
  updateAudio();
  return tile;
}

function removeTile(el) {
  const tile = tiles.get(el);
  if (tile) tile.destroy();
  tiles.delete(el);
  grid.removeWidget(el);
  applyLayout();
  updateAudio();
  if (tiles.size === 0) showStart();
}

function clearTiles() {
  for (const [el, tile] of tiles) {
    tile.destroy();
    grid.removeWidget(el);
  }
  tiles.clear();
}

// Tap on a tree item: single full-canvas loop of that scope.
function playScope(scope, label) {
  clearTiles();
  paused = false;
  updatePauseBtn();
  addTile(scope, label);
  document.getElementById("sidebar").classList.remove("open");
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

function setClipDuration(dur) {
  clipDuration = dur;
  document.querySelectorAll(".dur-btn").forEach(b =>
    b.classList.toggle("active", +b.dataset.dur === dur));
  // Drop prefetched clips so the new duration applies from the next skip.
  for (const t of tiles.values()) t.next = null;
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
//  Library tree
// ---------------------------------------------------------------------
async function loadTree() {
  const data = await (await fetch("/tree")).json();
  const lib = document.getElementById("library");
  lib.replaceChildren();
  lib.append(treeRow("home", "Tutti i video", "", true));
  renderNodes(data, lib, 0);
}

function renderNodes(nodes, parent, depth) {
  for (const n of nodes) {
    if (n.type === "dir") {
      const row = treeRow("folder", n.name, n.path);
      row.style.paddingLeft = `${12 + depth * 16}px`;

      const caret = document.createElement("button");
      caret.className = "caret";
      caret.innerHTML = '<span class="material-icons-round">chevron_right</span>';
      row.prepend(caret);

      const kids = document.createElement("div");
      kids.className = "children";
      renderNodes(n.children, kids, depth + 1);

      caret.addEventListener("click", e => {
        e.stopPropagation();
        const open = kids.classList.toggle("open");
        caret.classList.toggle("open", open);
      });
      for (const ev of ["pointerdown", "touchstart"])
        caret.addEventListener(ev, e => e.stopPropagation());

      parent.append(row, kids);
    } else {
      const row = treeRow("movie", n.name, n.path);
      row.style.paddingLeft = `${12 + depth * 16 + 26}px`;
      parent.append(row);
    }
  }
}

function treeRow(icon, label, scope, isRoot = false) {
  const row = document.createElement("div");
  row.className = "tree-row" + (isRoot ? " root" : "");
  row.innerHTML =
    `<span class="material-icons-round">${icon}</span><span class="row-name">${label}</span>`;
  row.addEventListener("click", () => {
    if (row._dragged) { row._dragged = false; return; }
    playScope(scope, isRoot ? "Tutti i video" : label);
  });
  makeDraggable(row, scope, label);
  return row;
}

// ---------------------------------------------------------------------
//  Long-press drag from the tree into the canvas (pointer events)
// ---------------------------------------------------------------------
function makeDraggable(row, scope, label) {
  let pressT = null, dragging = false, startX = 0, startY = 0;
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
      hint.classList.toggle("armed", !overSidebar(e.clientX));
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
    if (e.type === "pointerup" && !overSidebar(e.clientX)) {
      addTile(scope, label);
    }
    // keep _dragged=true so the trailing click doesn't also play
    setTimeout(() => { row._dragged = false; }, 300);
  };
  row.addEventListener("pointerup", finish);
  row.addEventListener("pointercancel", finish);

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
    if (!document.getElementById("sidebar").classList.contains("open"))
      document.getElementById("topbar").classList.add("hidden");
  }, 3500);
}

// ---------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------
window.addEventListener("load", () => {
  initGrid();
  loadTree();

  document.getElementById("start-screen").addEventListener("click", () =>
    playScope("", "Tutti i video"));
  document.getElementById("menuBtn").addEventListener("click", () =>
    document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("closeSidebar").addEventListener("click", () =>
    document.getElementById("sidebar").classList.remove("open"));
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("nextBtn").addEventListener("click", nextAll);
  document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.querySelectorAll(".dur-btn").forEach(b =>
    b.addEventListener("click", () => setClipDuration(+b.dataset.dur)));

  document.addEventListener("pointermove", pokeTopbar);
  document.addEventListener("pointerdown", pokeTopbar);
  pokeTopbar();
});
