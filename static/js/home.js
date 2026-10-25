"use strict";

// ---------------------------------------------------------------------
//  Home (the start screen): play everything, a random mosaic, the saved
//  mosaics and regie, the theme and a line about the library. Its first
//  tap also unlocks unmuted autoplay. Behind it a ghost mosaic keeps
//  re-arranging itself (randomSplit), only while the home is showing.
// ---------------------------------------------------------------------
const HOME_BEAT = 3200;        // ms between two arrangements of the ghost mosaic
let homeT = null;

const homeShown = () => !document.getElementById("start-screen").classList.contains("hidden");

function showStart() {
  document.getElementById("start-screen").classList.remove("hidden");
  renderHome();
  homeMosaic();
}

function hideStart() {
  document.getElementById("start-screen").classList.add("hidden");
  clearTimeout(homeT);
}

function homeChip(icon, label, onTap, count) {
  const b = document.createElement("button");
  b.className = "btn ghost home-chip";
  b.innerHTML = `<span class="material-icons-round">${icon}</span>` +
                `<span class="row-name">${escapeHtml(label)}</span>` +
                (count !== undefined ? `<span class="mosaic-count">${count}</span>` : "");
  b.addEventListener("click", onTap);
  return b;
}

function renderHome() {
  document.getElementById("homeMosaics").replaceChildren(...mosaics.map(m => m.kind === "smart"
    ? homeChip("auto_awesome", m.name, () => Smart.load(m.smart), "regia")
    : homeChip("dashboard", m.name, () => loadMosaic(m), m.tiles.length)));
  document.getElementById("homeMosaicsSec").classList.toggle("hidden", !mosaics.length);

  const stats = document.getElementById("homeStats");
  if (libFiles.length) {
    const nd = (function count(ns) {
      return ns.reduce((a, n) => n.type === "dir" ? a + 1 + count(n.children) : a, 0);
    })(libTree);
    stats.textContent = `${libFiles.length} video in ${nd} cartelle · ` +
      "tieni premuto un elemento della libreria e trascinalo per comporre un mosaico";
  }
}

// One arrangement of the ghost mosaic: 3 to 6 cells, one of them lit.
// Cells left over fade out where they are; CSS moves the others.
function homeMosaic() {
  clearTimeout(homeT);
  if (!homeShown()) return;
  const bg = document.getElementById("start-bg");
  while (bg.children.length < MAX_TILES) bg.append(document.createElement("i"));
  const rects = randomSplit(3 + Math.floor(Math.random() * (MAX_TILES - 2)));
  const lit = Math.floor(Math.random() * rects.length);
  [...bg.children].forEach((c, i) => {
    c.classList.toggle("off", i >= rects.length);
    c.classList.toggle("lit", i === lit);
    if (i >= rects.length) return;
    const [x, y, w, h] = rects[i];
    c.style.left = (x / GRID_COLS) * 100 + "%";
    c.style.top = (y / GRID_ROWS) * 100 + "%";
    c.style.width = (w / GRID_COLS) * 100 + "%";
    c.style.height = (h / GRID_ROWS) * 100 + "%";
  });
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    homeT = setTimeout(homeMosaic, HOME_BEAT);
}
