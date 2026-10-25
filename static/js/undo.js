"use strict";

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
