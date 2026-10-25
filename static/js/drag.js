"use strict";

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
      // On a phone the drawer covers the whole screen: get it out of the
      // way so there is a mosaic to drop on.
      if (isPhone()) closeSidebar();
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
    if (!tiles.size && !Smart.active &&
        !document.getElementById("sidebar").classList.contains("open")) showStart();
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
