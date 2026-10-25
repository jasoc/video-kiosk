"use strict";

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
