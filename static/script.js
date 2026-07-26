// =====================================================================
//  Video Kiosk — tree + random clip loops + mosaic grid
//
//  Playback: each tile owns TWO <video> elements (double buffer), reused
//  forever. While one plays, the next clip is prefetched on the hidden
//  one, then swapped with a crossfade. No element is ever created per
//  clip, so client memory stays flat.
//
//  Per tile: mode "clips" (random clips, 5..60s) or "full" (whole
//  videos looped). Mosaics (tiles + modes + geometry) can be saved to
//  localStorage and reloaded from the sidebar.
// =====================================================================

"use strict";

const MAX_TILES = 6;
const GRID_ROWS = 12;
const PRESS_MS = 350;          // long-press before a tree drag starts
const DRAG_SLOP = 12;          // px of movement that cancels a press
const DURATIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const STORE_KEY = "kiosk.mosaics";

let grid;                      // GridStack instance
let paused = false;
let currentPreset = "auto";
const tiles = new Map();       // gridstack item el -> Tile

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

function splitEven(n) {
  const base = Math.floor(12 / n), rem = 12 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

const PRESETS = {
  auto:   { label: "Auto", icon: "auto_awesome_mosaic",
            fits: n => n >= 1 && n <= 6, gen: n => AUTO_LAYOUTS[n] },
  cols:   { label: "Colonne", icon: "view_column",
            fits: n => n >= 2 && n <= 6,
            gen: n => { let x = 0; return splitEven(n).map(w => { const r = [x, 0, w, 12]; x += w; return r; }); } },
  rows:   { label: "Righe", icon: "table_rows",
            fits: n => n >= 2 && n <= 6,
            gen: n => { let y = 0; return splitEven(n).map(h => { const r = [0, y, 12, h]; y += h; return r; }); } },
  grid22: { label: "Griglia 2×2", icon: "grid_view",
            fits: n => n >= 2 && n <= 4,
            gen: n => [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 6, 6], [6, 6, 6, 6]].slice(0, n) },
  grid32: { label: "Griglia 3×2", icon: "grid_on",
            fits: n => n >= 2 && n <= 6,
            gen: n => [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 4, 6], [4, 6, 4, 6], [8, 6, 4, 6]].slice(0, n) },
};

function layoutFor(n) {
  const p = PRESETS[currentPreset];
  return (p && p.fits(n) ? p : PRESETS.auto).gen(n);
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

    // --- overlay controls ---
    this.overlay = document.createElement("div");
    this.overlay.className = "tile-overlay";
    this.chip = document.createElement("span");
    this.chip.className = "tile-chip";
    this.chip.textContent = label;
    this.durBtn = tilePill(() => this.toggleDurPanel());
    this.modeBtn = tileBtn("shuffle", () => this.toggleMode());
    const skip = tileBtn("skip_next", () => this.advance());
    const close = tileBtn("close", () => removeTile(this.root.parentElement));
    this.overlay.append(this.chip, this.durBtn, this.modeBtn, skip, close);

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
    this.durBtn.textContent = this.duration + "s";
    this.durBtn.style.display = this.mode === "clips" ? "" : "none";
    this.durPanel.querySelectorAll(".dur-opt").forEach(b =>
      b.classList.toggle("active", +b.dataset.dur === this.duration));
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

    // A full-mode tile scoped to a single file loops natively: seamless,
    // no timers, no prefetch traffic.
    el.loop = this.mode === "full" && !!this.scope && clip.file === this.scope;

    el.muted = tiles.size > 1;      // audio only in single view
    if (!paused) {
      el.play().catch(() => {});
      this.armTimer();
    }
    this.chip.textContent = clip.file.split("/").pop();
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
    for (const v of this.videos) {
      v.pause();
      v.removeAttribute("src");
      v.load();                 // release decoder + buffers
    }
    this.root.replaceChildren();
  }
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
  if (!items.length) return;
  const layout = layoutFor(items.length);
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

function addTile(scope, label, opts = {}) {
  if (tiles.size >= MAX_TILES) {
    toast(`Massimo ${MAX_TILES} video nel mosaico`);
    return null;
  }
  hideStart();
  let rect;
  if (opts.rect) {
    rect = opts.rect;
  } else {
    // Shrink existing tiles to the (n+1)-tile layout first so the new
    // widget's slot is guaranteed to be free (maxRow forbids overflow).
    const layout = layoutFor(tiles.size + 1);
    const items = grid.getGridItems();
    grid.batchUpdate();
    items.forEach((itemEl, i) => {
      const [x, y, w, h] = layout[i];
      grid.update(itemEl, { x, y, w, h });
    });
    grid.batchUpdate(false);
    const [x, y, w, h] = layout[items.length];
    rect = { x, y, w, h };
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
  document.getElementById("sidebar").classList.remove("open");
}

// Tap on a tree item: single full-canvas loop of that scope.
function playScope(scope, label) {
  clearTiles();
  paused = false;
  currentPreset = "auto";
  updatePauseBtn();
  addTile(scope, label);
  document.getElementById("sidebar").classList.remove("open");
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
      pop.classList.add("hidden");
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

function snapshotMosaic(name) {
  const items = grid.getGridItems().map(el => {
    const t = tiles.get(el);
    return {
      scope: t.scope, label: t.label, mode: t.mode, duration: t.duration,
      x: +el.getAttribute("gs-x") || 0, y: +el.getAttribute("gs-y") || 0,
      w: +el.getAttribute("gs-w") || 12, h: +el.getAttribute("gs-h") || 12,
    };
  });
  return { name, preset: currentPreset, tiles: items };
}

function loadMosaic(m) {
  clearTiles();
  paused = false;
  currentPreset = m.preset || "auto";
  updatePauseBtn();
  for (const td of m.tiles.slice(0, MAX_TILES)) {
    addTile(td.scope, td.label, {
      mode: td.mode, duration: td.duration,
      rect: { x: td.x, y: td.y, w: td.w, h: td.h },
    });
  }
  document.getElementById("sidebar").classList.remove("open");
}

function renderMosaics() {
  const box = document.getElementById("mosaics");
  box.replaceChildren();
  const list = loadStore();
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Nessun mosaico salvato";
    box.append(p);
    return;
  }
  list.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "mosaic-row";
    row.innerHTML =
      `<span class="material-icons-round">dashboard</span>` +
      `<span class="row-name">${escapeHtml(m.name)}</span>` +
      `<span class="mosaic-count">${m.tiles.length}</span>`;
    const del = document.createElement("button");
    del.className = "sb-icon-btn";
    del.innerHTML = '<span class="material-icons-round">delete_outline</span>';
    del.addEventListener("click", e => {
      e.stopPropagation();
      const next = loadStore();
      next.splice(i, 1);
      saveStore(next);
    });
    row.append(del);
    row.addEventListener("click", () => loadMosaic(m));
    box.append(row);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function openSaveModal() {
  if (tiles.size === 0) {
    toast("Nessun video nel mosaico");
    return;
  }
  const input = document.getElementById("mosaicName");
  input.value = "";
  input.placeholder = `Mosaico ${loadStore().length + 1}`;
  document.getElementById("save-modal").classList.remove("hidden");
  setTimeout(() => input.focus(), 50);
}

function confirmSave() {
  const input = document.getElementById("mosaicName");
  const name = input.value.trim() || input.placeholder;
  const list = loadStore();
  list.push(snapshotMosaic(name));
  saveStore(list);
  document.getElementById("save-modal").classList.add("hidden");
  toast("Mosaico salvato");
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

// ---------------------------------------------------------------------
//  Library tree
// ---------------------------------------------------------------------
async function loadTree() {
  const data = await (await fetch("/tree")).json();
  const lib = document.getElementById("library");
  lib.replaceChildren();
  lib.append(treeRow("home", "Tutti i video", "", true, true));
  renderNodes(data, lib, 0);
}

function renderNodes(nodes, parent, depth) {
  for (const n of nodes) {
    if (n.type === "dir") {
      const row = treeRow("folder", n.name, n.path, false, true);
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

function treeRow(icon, label, scope, isRoot = false, canMosaic = false) {
  const row = document.createElement("div");
  row.className = "tree-row" + (isRoot ? " root" : "");
  row.innerHTML =
    `<span class="material-icons-round">${icon}</span><span class="row-name">${escapeHtml(label)}</span>`;
  if (canMosaic) {
    const mb = document.createElement("button");
    mb.className = "tree-action";
    mb.title = "Mosaico casuale";
    mb.innerHTML = '<span class="material-icons-round">auto_awesome_mosaic</span>';
    stopDrag(mb);
    mb.addEventListener("click", e => {
      e.stopPropagation();
      randomMosaic(scope, isRoot ? "Tutti i video" : label);
    });
    row.append(mb);
  }
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
  document.getElementById("closeSidebar").addEventListener("click", () =>
    document.getElementById("sidebar").classList.remove("open"));
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("nextBtn").addEventListener("click", nextAll);
  document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.getElementById("layoutBtn").addEventListener("click", e => {
    e.stopPropagation();
    toggleLayoutPop();
  });
  document.getElementById("saveMosaicBtn").addEventListener("click", openSaveModal);
  document.getElementById("saveCancel").addEventListener("click", () =>
    document.getElementById("save-modal").classList.add("hidden"));
  document.getElementById("saveConfirm").addEventListener("click", confirmSave);
  document.getElementById("mosaicName").addEventListener("keydown", e => {
    if (e.key === "Enter") confirmSave();
  });
  document.getElementById("save-modal").addEventListener("click", e => {
    if (e.target.id === "save-modal") e.target.classList.add("hidden");
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
