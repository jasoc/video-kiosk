"use strict";

// ---------------------------------------------------------------------
//  Themes: all on pure black, picked per device. The tokens live in
//  css/themes.css; index.html applies the saved one before the first paint.
// ---------------------------------------------------------------------
const THEMES = [
  { id: "camera", name: "Camera oscura", font: '"IBM Plex Mono", monospace',
    colors: ["#ff3b2e", "#ffb0a6", "#44120e"] },
  { id: "pellicola", name: "Pellicola", font: '"Space Grotesk", sans-serif',
    colors: ["#ffad1f", "#f4ead6", "#3c3119"] },
  { id: "ghiaccio", name: "Ghiaccio", font: '"Inter", sans-serif',
    colors: ["#3fe0cf", "#e4f4f3", "#1e3a3f"] },
  { id: "vetro", name: "Vetro", font: '"Geist", sans-serif',
    colors: ["linear-gradient(145deg,#fff,#9fd6ff)", "rgba(255,255,255,.5)", "rgba(255,255,255,.2)"] },
  { id: "luci", name: "Luci rosse", font: '"Playfair Display", serif',
    colors: ["#9e0f28", "#f4ece9", "#1c0a0e"] },
  { id: "lusso", name: "Lusso", font: '"Cinzel", serif',
    colors: ["linear-gradient(135deg,#a8822f,#f3dc9f,#a8822f)", "#8a4b22", "#f2e6cf"] },
  { id: "galleria", name: "Galleria", font: '"Archivo", sans-serif',
    colors: ["#ffffff", "#9a9a9a", "#3a3a3a"] },
  { id: "retro", name: "404", font: 'Tahoma, Verdana, "Noto Sans", sans-serif',
    colors: ["linear-gradient(180deg,#8fdc4f,#2f8f12)", "linear-gradient(180deg,#3a3a3a,#0a0a0a)", "#f8b32c"] },
  { id: "rave", name: "Rave", font: '"UnifrakturCook", serif',
    colors: ["#ff1f1f", "linear-gradient(180deg,#fff,#6d6d6d)", "#000000"] },
];

// A theme saved on this device that no longer exists falls back to the default.
const currentTheme = () => {
  const t = document.documentElement.dataset.theme;
  return THEMES.some(x => x.id === t) ? t : "camera";
};

function applyTheme(id) {
  if (id === "camera") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try { localStorage.setItem("kiosk.theme", id); } catch (e) {}
  renderThemeBar();
  syncGlass();
}

// ---------------------------------------------------------------------
//  Adaptive glass ("vetro" only). Like Apple's liquid glass, every
//  floating surface looks at what is under it: over bright footage it
//  turns milky with dark text, over dark footage smoky with white text,
//  and its accent is the complement of the colour behind it. Twice a
//  second each visible surface draws the videos under it into a tiny
//  canvas and averages them (same-origin videos: the canvas stays clean).
//  Areas with no video under them count as the black background.
// ---------------------------------------------------------------------
const GLASS_SURFACES = ["#topbar:not(.hidden)", "#sidebar.open", ".tile-overlay.visible",
                        ".tile-durs.visible", ".pop:not(.hidden)", "#toast:not(.hidden)",
                        ".sm-stagebar.visible", ".sm-pill:not(.hidden)",
                        ".modal-wrap:not(.hidden) > .modal", ".modal-wrap:not(.hidden) > .ed"];
// Light appearance: everything a surface needs to read on bright footage.
const GLASS_LIGHT = {
  "--text": "#0b0b0f", "--text-2": "rgba(0, 0, 0, 0.66)", "--text-3": "rgba(0, 0, 0, 0.42)",
  "--panel": "rgba(255, 255, 255, 0.28)", "--panel-2": "rgba(255, 255, 255, 0.4)",
  "--panel-3": "rgba(255, 255, 255, 0.55)", "--line": "rgba(0, 0, 0, 0.1)",
  "--line-strong": "rgba(0, 0, 0, 0.18)", "--accent-ink": "#ffffff",
  "--accent-fill": "linear-gradient(180deg, rgba(28, 28, 32, 0.92), rgba(48, 48, 56, 0.86))",
  "--surface": "linear-gradient(145deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.36) 45%, rgba(255, 255, 255, 0.5))",
  "--scrim": "linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.5))",
};
let glassT = null, glassCv = null;

function syncGlass() {
  clearInterval(glassT);
  glassT = null;
  if (currentTheme() === "vetro") {
    glassT = setInterval(glassTick, 500);
    glassTick();
  } else {
    for (const el of document.querySelectorAll("[data-glass]")) untint(el);
  }
}

function untint(el) {
  for (const k of [...Object.keys(GLASS_LIGHT), "--accent"]) el.style.removeProperty(k);
  delete el.dataset.glass;
}

// Average colour of what is on screen inside rect R.
function averageUnder(R) {
  glassCv ||= Object.assign(document.createElement("canvas"), { width: 32, height: 18 });
  const ctx = glassCv.getContext("2d", { willReadFrequently: true });
  let r = 0, g = 0, b = 0, covered = 0;
  for (const v of document.querySelectorAll("video.front")) {
    if (!v.videoWidth) continue;
    const E = v.getBoundingClientRect();
    const x0 = Math.max(R.left, E.left), x1 = Math.min(R.right, E.right);
    const y0 = Math.max(R.top, E.top), y1 = Math.min(R.bottom, E.bottom);
    if (x1 <= x0 || y1 <= y0) continue;
    // Where the frame sits inside the element (object-fit cover/contain).
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = (v.style.objectFit === "contain" ? Math.min : Math.max)(E.width / vw, E.height / vh);
    const ox = E.left + (E.width - vw * s) / 2, oy = E.top + (E.height - vh * s) / 2;
    const cx = x => clamp(Math.floor((x - ox) / s / vw * 32), 0, 31);
    const cy = y => clamp(Math.floor((y - oy) / s / vh * 18), 0, 17);
    let px;
    try {
      ctx.drawImage(v, 0, 0, 32, 18);
      const ax = cx(x0), ay = cy(y0);
      px = ctx.getImageData(ax, ay, Math.max(1, cx(x1) - ax + 1), Math.max(1, cy(y1) - ay + 1)).data;
    } catch (e) { continue; }
    let pr = 0, pg = 0, pb = 0;
    for (let i = 0; i < px.length; i += 4) { pr += px[i]; pg += px[i + 1]; pb += px[i + 2]; }
    const n = px.length / 4, area = (x1 - x0) * (y1 - y0);
    r += pr / n * area; g += pg / n * area; b += pb / n * area;
    covered += area;
  }
  const total = Math.max(covered, R.width * R.height);   // the rest is black
  return { r: r / total, g: g / total, b: b / total };
}

function glassTick() {
  if (document.hidden) return;
  const seen = new Set();
  for (const sel of GLASS_SURFACES) {
    for (const el of document.querySelectorAll(sel)) {
      const R = el.getBoundingClientRect();
      if (R.width < 4 || R.height < 4) continue;
      tint(el, averageUnder(R));
      seen.add(el);
    }
  }
  for (const el of document.querySelectorAll("[data-glass]")) if (!seen.has(el)) untint(el);
}

function tint(el, { r, g, b }) {
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Hysteresis: footage hovering around mid-grey doesn't make it flicker.
  const light = el.dataset.glass === "light" ? lum > 0.45 : lum > 0.58;
  el.dataset.glass = light ? "light" : "dark";
  for (const [k, v] of Object.entries(GLASS_LIGHT)) {
    if (light) el.style.setProperty(k, v); else el.style.removeProperty(k);
  }
  // Accent: the complement of the colour behind; neutral footage keeps a
  // calm system blue.
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max ? (max - min) / max : 0;
  let accent;
  if (sat < 0.15) {
    accent = light ? "#0a64d8" : "#9fd6ff";
  } else {
    const d = max - min;
    let h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    h = ((h * 60 + 180) % 360 + 360) % 360;
    accent = `hsl(${Math.round(h)} 85% ${light ? 36 : 72}%)`;
  }
  el.style.setProperty("--accent", accent);
}

// The picker in the drawer and the one on the home.
function renderThemeBar() {
  for (const id of ["themeBar", "homeThemes"]) {
    const bar = document.getElementById(id);
    bar.replaceChildren();
    for (const t of THEMES) {
      const b = document.createElement("button");
      b.className = "theme-opt" + (t.id === currentTheme() ? " active" : "");
      b.innerHTML = `<span class="theme-swatch">${t.colors.map(c => `<i style="background:${c}"></i>`).join("")}</span>` +
                    `<span style="font-family:${t.font.replace(/"/g, "'")}">${t.name}</span>`;
      b.addEventListener("click", () => applyTheme(t.id));
      bar.append(b);
    }
  }
}

function showTab(id) {
  for (const t of document.querySelectorAll(".sb-tab"))
    t.classList.toggle("active", t.dataset.tab === id);
  document.getElementById("tab-lib").classList.toggle("hidden", id !== "lib");
  document.getElementById("tab-mos").classList.toggle("hidden", id !== "mos");
  document.getElementById("tab-smart").classList.toggle("hidden", id !== "smart");
  if (id === "mos") refreshMosaics();
  if (id === "smart") Smart.pollStatus();
}
