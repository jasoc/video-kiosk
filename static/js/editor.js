"use strict";

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
