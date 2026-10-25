"use strict";

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
  if (homeShown()) renderHome();
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
