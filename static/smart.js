// =====================================================================
//  Regia — the smart mosaic. A mode of its own, separate from the tile
//  grid: its own stage, its own cells and its own free layout.
//
//  No machine learning. The server analyses every video once (analysis.py)
//  into shots: start/end at real cuts, how much the picture moves, its
//  brightness and dominant colour, plus the video's real orientation. The
//  director below is a handful of readable rules on top of that:
//
//   - clips are whole shots (or a window of a long one), never cut mid-shot
//     at random;
//   - a "phase" picks an energy (calm / busy) and often a colour; shots are
//     chosen to match it, and the next phase contrasts with the last;
//   - the number of cells breathes slowly (1 → density → 1), changing by
//     one at a time;
//   - the layout is a tree of splits: a new clip goes where splitting a
//     cell gives it a frame of its own shape (vertical clips get vertical
//     cells), and a cell's next clip is chosen to fit its shape;
//   - cells change one at a time, as their shots end, never all together.
//
//  Each cell owns two <video> elements (double buffer), like a tile, and
//  releases them when it goes away. Everything else is a few numbers.
// =====================================================================

"use strict";

const Smart = (() => {
  const RHYTHMS = [   // seconds between moves, clip length range
    { label: "Calmo",     tick: 14,  min: 6,   max: 16 },
    { label: "Disteso",   tick: 10,  min: 4,   max: 12 },
    { label: "Medio",     tick: 7,   min: 3,   max: 8 },
    { label: "Vivace",    tick: 5,   min: 2,   max: 6 },
    { label: "Frenetico", tick: 3.5, min: 1.5, max: 4 },
  ];
  const MIN_CELL_PX = 140;
  const GAP = 3;
  const FADE_MS = 700;
  const STORE = "kiosk.smart";

  const cfg = { sources: [], rhythm: 2, density: 5, volume: 0.25 };
  const cells = new Set();
  let active = false;
  let stage = null;
  let shots = [];            // usable shots of the sources, see buildShots()
  let recent = [];           // ids of shots played lately
  let phase = null;
  let root = null;           // layout tree: {cell} | {dir, ratio, a, b}
  let beat = 0, busy = false, snapshot = null;
  let tickT = null, poolT = null, statusT = null, barT = null;
  let lastStatus = null;

  const $ = id => document.getElementById(id);
  const rhythm = () => RHYTHMS[cfg.rhythm];

  // -------------------------------------------------------------------
  //  Settings
  // -------------------------------------------------------------------
  function clean(c = {}) {
    const num = (v, d) => typeof v === "number" && isFinite(v) ? v : d;
    return {
      sources: Array.isArray(c.sources) ? c.sources.filter(s => typeof s === "string") : [],
      rhythm: clamp(Math.round(num(c.rhythm, 2)), 0, RHYTHMS.length - 1),
      density: clamp(Math.round(num(c.density, 5)), 1, MAX_TILES),
      volume: clamp(num(c.volume, 0.25), 0, 1),
    };
  }

  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) {}
  }

  function addSource(scope) {
    if (!cfg.sources.includes(scope)) cfg.sources.push(scope);
    persist();
    renderPanel();
    api("POST", "/analysis/queue", { targets: [scope] }).catch(() => {});
    toast(`Regia: ${scopeLabel(scope)} aggiunta`);
    if (active) refreshPool();
    pollStatus();
  }

  function removeSource(i) {
    cfg.sources.splice(i, 1);
    persist();
    renderPanel();
    if (active) refreshPool();
  }

  // -------------------------------------------------------------------
  //  Material: the analysed shots of the sources
  // -------------------------------------------------------------------
  function buildShots(files) {
    const out = [];
    for (const f of files) {
      for (const [a, b, motion, luma, u, v] of f.shots) {
        if (b - a < 1.5 || luma < 28) continue;      // too short, or black
        const du = u - 128, dv = v - 128;
        out.push({ id: `${f.file}@${a}`, file: f.file, a, b, motion,
                   sat: Math.min(1, Math.hypot(du, dv) / 40), hue: Math.atan2(dv, du),
                   aspect: f.aspect, crop: f.crop });
      }
    }
    // Motion as a percentile: "calm" and "busy" mean the same in any folder.
    const sorted = out.map(s => s.motion).sort((x, y) => x - y);
    for (const s of out) {
      let i = 0;
      while (i < sorted.length && sorted[i] < s.motion) i++;
      s.energy = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
    }
    return out;
  }

  async function refreshPool() {
    clearTimeout(poolT);
    if (!active) return;
    const params = new URLSearchParams();
    for (const s of cfg.sources) params.append("target", s);
    try { shots = buildShots(await api("GET", `/smart/pool?${params}`)); }
    catch (e) { /* keep what we had */ }
    $("smWait").classList.toggle("hidden", shots.length > 0);
    if (shots.length && !cells.size) grow();
    // While the analysis is still filling in, look for new material.
    const cov = lastStatus && Object.values(lastStatus.coverage || {});
    const complete = cov && cov.length && cov.every(([r, t]) => r >= t);
    poolT = setTimeout(refreshPool, shots.length ? (complete ? 120000 : 30000) : 4000);
  }

  // -------------------------------------------------------------------
  //  Choosing shots
  // -------------------------------------------------------------------
  function newPhase() {
    const prev = phase ? phase.energy : 0.5;
    // Contrast with the previous phase: calm after busy and vice versa.
    const energy = prev > 0.5 ? 0.05 + Math.random() * 0.4 : 0.55 + Math.random() * 0.4;
    const hue = Math.random() < 0.6 ? Math.random() * 2 * Math.PI - Math.PI : null;
    phase = { energy, hue, until: beat + 3 + Math.floor(Math.random() * 3) };
  }

  const hueDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const fitCost = (a, b) => Math.abs(Math.log(a / b));

  // Best shot for a cell of aspect `cellAspect` (null: any shape).
  function pickShot(cellAspect) {
    if (!shots.length) return null;
    const playing = new Set([...cells].map(c => c.clip?.file));
    const n = Math.min(shots.length, 300);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = shots.length <= 300 ? shots[i] : shots[Math.floor(Math.random() * shots.length)];
      let score = -2 * Math.abs(s.energy - phase.energy);
      if (phase.hue !== null) score -= 1.2 * s.sat * hueDist(s.hue, phase.hue) / Math.PI;
      if (cellAspect) score -= 1.5 * fitCost(cellAspect, s.aspect);
      if (playing.has(s.file)) score -= 2.5;
      if (recent.includes(s.id)) score -= 2;
      score += Math.random() * 0.7;                  // a little variety
      if (score > bestScore) { bestScore = score; best = s; }
    }
    recent.push(best.id);
    if (recent.length > 60) recent.shift();
    // A shot longer than the rhythm allows plays a window of it.
    const len = best.b - best.a, max = rhythm().max;
    const start = best.a + (len > max ? Math.random() * (len - max) : 0);
    return { file: best.file, start, length: Math.min(len, max),
             aspect: best.aspect, crop: best.crop };
  }

  // -------------------------------------------------------------------
  //  Cell: one video slot of the stage
  // -------------------------------------------------------------------
  class Cell {
    constructor() {
      this.el = document.createElement("div");
      this.el.className = "sm-cell";
      this.videos = [this.makeVideo(), this.makeVideo()];
      this.el.append(...this.videos);
      this.active = 0;
      this.gen = 0;              // bumped to cancel stale loads
      this.clip = null;
      this.next = null;          // { clip, el } prefetched
      this.timer = null;
      this.rect = null;
      stage.append(this.el);
    }

    makeVideo() {
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.muted = true;
      return v;
    }

    aspect() { return this.rect ? this.rect.w / this.rect.h : null; }

    // Load `clip` into the hidden element; resolves with it when playable.
    load(clip) {
      const el = this.videos[1 - this.active], gen = this.gen;
      return new Promise((resolve, reject) => {
        el._done?.(false);       // a previous load on el settles as stale
        let settled = false;
        const done = el._done = ok => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          el.oncanplay = el.onloadedmetadata = el.onerror = null;
          ok && gen === this.gen ? resolve(el) : reject(new Error("stale"));
        };
        const watchdog = setTimeout(() => done(false), 10000);
        el.onerror = () => done(false);
        el.onloadedmetadata = () => {
          try { el.currentTime = clip.start; } catch (e) {}
          el.oncanplay = () => done(true);
        };
        // Proxies (with audio) as soon as there is more than one cell.
        el.src = `/video/${encodePath(clip.file)}${cells.size > 1 ? "?q=low" : ""}`;
        el.load();
      });
    }

    show(clip, el) {
      const old = this.videos[this.active];
      this.active = this.videos.indexOf(el);
      this.clip = clip;
      el.classList.add("front");
      old.classList.remove("front");
      old.pause();
      el.volume = cfg.volume;
      el.muted = false;
      if (!paused) el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
      this.fit();
      this.arm();
      this.prefetch();
    }

    arm() {
      clearTimeout(this.timer);
      if (paused || !this.clip) return;
      const v = this.videos[this.active];
      const left = this.clip.start + this.clip.length - v.currentTime;
      this.timer = setTimeout(() => this.advance(), Math.max(0.3, left) * 1000);
    }

    async prefetch() {
      const gen = this.gen;
      const clip = pickShot(this.aspect());
      if (!clip) return;
      try {
        const el = await this.load(clip);
        if (gen === this.gen) this.next = { clip, el };
      } catch (e) { /* advance() loads on demand */ }
    }

    // Next clip, chosen for this cell's current shape.
    async advance() {
      clearTimeout(this.timer);
      let n = this.next;
      this.next = null;
      const gen = ++this.gen;
      if (!n) {
        const clip = pickShot(this.aspect());
        if (!clip) return;
        try { n = { clip, el: await this.load(clip) }; }
        catch (e) {
          if (gen === this.gen) this.timer = setTimeout(() => this.advance(), 2000);
          return;
        }
        if (gen !== this.gen) return;
      }
      this.show(n.clip, n.el);
    }

    place(rect) {
      this.rect = rect;
      Object.assign(this.el.style, {
        left: rect.x + "px", top: rect.y + "px",
        width: rect.w + "px", height: rect.h + "px",
      });
      this.fit();
    }

    // Crop the black bars baked into the frame (box from the analysis):
    // contain + a scale that blows the content up to cover the cell.
    fit() {
      const v = this.videos[this.active], box = this.clip?.crop, r = this.rect;
      for (const x of this.videos) { x.style.objectFit = "cover"; x.style.transform = ""; }
      if (!box || !r || !v.videoWidth) return;
      const vw = v.videoWidth, vh = v.videoHeight, s = Math.min(r.w / vw, r.h / vh);
      const k = clamp(Math.max(r.w / (box[2] * vw * s), r.h / (box[3] * vh * s)), 1, 8);
      const dx = (box[0] + box[2] / 2 - 0.5) * vw * s;
      const dy = (box[1] + box[3] / 2 - 0.5) * vh * s;
      v.style.objectFit = "contain";
      v.style.transform = `translate(${-k * dx}px, ${-k * dy}px) scale(${k})`;
    }

    setPaused(p) {
      const v = this.videos[this.active];
      if (p) { clearTimeout(this.timer); v.pause(); }
      else { v.play().catch(() => {}); this.arm(); }
    }

    destroy() {
      this.gen++;
      clearTimeout(this.timer);
      for (const v of this.videos) {
        v.pause();
        v.removeAttribute("src");
        v.load();                // release decoder + buffers
      }
      this.el.remove();
    }
  }

  // -------------------------------------------------------------------
  //  Layout: a tree of splits. "v" = side by side, "h" = stacked.
  // -------------------------------------------------------------------
  function walk(fn) {
    const W = stage.clientWidth, H = stage.clientHeight;
    const go = (n, x, y, w, h) => {
      if (n.cell) return fn(n, { x, y, w, h });
      if (n.dir === "v") {
        const wa = w * n.ratio;
        go(n.a, x, y, wa, h); go(n.b, x + wa, y, w - wa, h);
      } else {
        const ha = h * n.ratio;
        go(n.a, x, y, w, ha); go(n.b, x, y + ha, w, h - ha);
      }
    };
    if (root) go(root, 0, 0, W, H);
  }

  function layout() {
    walk((n, r) => n.cell.place({ x: r.x + GAP, y: r.y + GAP, w: r.w - 2 * GAP, h: r.h - 2 * GAP }));
    // Smart crop depends on the final size: redo it once the move ends.
    setTimeout(() => { for (const c of cells) c.fit(); }, FADE_MS + 100);
  }

  // Split the leaf where a clip of aspect `ac` gets a frame of its own
  // shape without wrecking the neighbour's; bigger cells are preferred.
  function insert(cell, ac) {
    if (!root) { root = { cell }; return true; }
    const W = stage.clientWidth, H = stage.clientHeight;
    let best = null;
    walk((node, r) => {
      for (const dir of ["v", "h"]) {
        const f = clamp(dir === "v" ? ac * r.h / r.w : r.w / (ac * r.h), 0.3, 0.7);
        const nw = dir === "v" ? r.w * f : r.w, nh = dir === "v" ? r.h : r.h * f;
        const ow = dir === "v" ? r.w - nw : r.w, oh = dir === "v" ? r.h : r.h - nh;
        if (Math.min(nw, nh, ow, oh) < MIN_CELL_PX) continue;
        const oa = node.cell.clip?.aspect || ow / oh;
        const cost = fitCost(nw / nh, ac) + fitCost(ow / oh, oa) - 0.8 * (r.w * r.h) / (W * H);
        if (!best || cost < best.cost) best = { cost, node, dir, f };
      }
    });
    if (!best) return false;
    const { node, dir, f } = best;
    const fresh = { cell }, old = { cell: node.cell };
    const first = Math.random() < 0.5;
    delete node.cell;
    Object.assign(node, { dir, ratio: first ? f : 1 - f,
                          a: first ? fresh : old, b: first ? old : fresh });
    return true;
  }

  // Take a leaf out: its sibling takes the parent's whole space.
  function detach(cell) {
    if (root?.cell === cell) { root = null; return; }
    const find = n => {
      if (n.cell) return null;
      if (n.a.cell === cell || n.b.cell === cell) return n;
      return find(n.a) || find(n.b);
    };
    const p = root && find(root);
    if (!p) return;
    const sib = p.a.cell === cell ? p.b : p.a;
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, sib);
  }

  // -------------------------------------------------------------------
  //  The director
  // -------------------------------------------------------------------
  // Number of cells wanted now: a slow wave from 1 up to the density and
  // back, each level held for two moves.
  function targetCount() {
    const max = cfg.density;
    const up = Array.from({ length: max }, (_, i) => i + 1);
    const wave = up.concat(up.slice(1, -1).reverse());
    return wave[Math.floor(beat / 2) % wave.length];
  }

  async function grow() {
    if (busy || !active) return;
    const clip = pickShot(null);
    if (!clip) return;
    busy = true;
    const cell = new Cell();
    try {
      const el = await cell.load(clip);
      if (!active || !insert(cell, clip.aspect)) throw new Error("no room");
      cells.add(cell);
      layout();
      cell.show(clip, el);
      requestAnimationFrame(() => cell.el.classList.add("in"));
    } catch (e) {
      cell.destroy();
    }
    busy = false;
  }

  function shrink() {
    const cell = cells.values().next().value;     // the oldest
    if (!cell) return;
    cells.delete(cell);
    detach(cell);
    cell.el.classList.remove("in");
    cell.el.classList.add("out");
    layout();
    setTimeout(() => cell.destroy(), FADE_MS);
  }

  // Shift one split a little: the cells breathe without changing.
  function nudge() {
    const splits = [];
    const go = n => { if (!n.cell) { splits.push(n); go(n.a); go(n.b); } };
    if (root) go(root);
    if (!splits.length) return false;
    const s = splits[Math.floor(Math.random() * splits.length)];
    s.ratio = clamp(s.ratio + (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.08), 0.3, 0.7);
    layout();
    return true;
  }

  function tick() {
    clearTimeout(tickT);
    if (!active) return;
    if (!paused && shots.length) {
      beat++;
      if (beat >= phase.until) newPhase();
      const want = targetCount();
      if (cells.size < want) grow();
      else if (cells.size > want) shrink();
      else if (Math.random() < 0.5 || !nudge()) {
        const list = [...cells];
        list[Math.floor(Math.random() * list.length)]?.advance();
      }
    }
    tickT = setTimeout(tick, rhythm().tick * 1000);
  }

  // -------------------------------------------------------------------
  //  Start / stop
  // -------------------------------------------------------------------
  async function start() {
    if (!cfg.sources.length) {
      toast("Aggiungi almeno una cartella alla regia");
      return;
    }
    if (!active) {
      // The mosaic steps aside (and its decoders are released); it comes
      // back as it was when the regia stops.
      snapshot = canvasSnap();
      clearTiles();
      hideStart();
      active = true;
      document.body.classList.add("smart-on");
      stage.classList.remove("hidden");
    }
    paused = false;
    updatePauseBtn();
    closeSidebar();
    renderPanel();
    api("POST", "/analysis/queue", { targets: cfg.sources }).catch(() => {});
    newPhase();
    beat = 0;
    await refreshPool();
    tick();
    pollStatus();
  }

  function stop(restore = true) {
    if (!active) return;
    clearTimeout(tickT);
    clearTimeout(poolT);
    for (const c of cells) c.destroy();
    cells.clear();
    root = null;
    shots = [];
    active = false;
    paused = false;
    updatePauseBtn();
    document.body.classList.remove("smart-on");
    stage.classList.add("hidden");
    $("smWait").classList.add("hidden");
    if (restore && snapshot) restoreCanvas(snapshot);
    snapshot = null;
    if (!tiles.size) showStart();
    renderPanel();
  }

  function setPaused(p) {
    for (const c of cells) c.setPaused(p);
  }

  function load(saved) {
    Object.assign(cfg, clean(saved));
    persist();
    renderPanel();
    start();
  }

  // -------------------------------------------------------------------
  //  Panel (drawer tab) and analysis progress
  // -------------------------------------------------------------------
  function renderPanel() {
    const box = $("smSources");
    box.replaceChildren();
    if (!cfg.sources.length) {
      const p = document.createElement("p");
      p.className = "sm-empty";
      p.textContent = "Nessuna cartella";
      box.append(p);
    }
    cfg.sources.forEach((s, i) => {
      const chip = document.createElement("span");
      chip.className = "ed-scope sm-src";
      const icon = !s ? "home" : libFiles.includes(s) ? "movie" : "folder";
      const cov = lastStatus?.coverage?.[s];
      chip.innerHTML = `<span class="material-icons-round">${icon}</span>` +
        `<span class="row-name">${escapeHtml(scopeLabel(s))}</span>` +
        (cov ? `<span class="sm-cov${cov[0] >= cov[1] ? " full" : ""}">${cov[0]}/${cov[1]}</span>` : "");
      chip.append(rowAction("close", "Togli dalla regia", () => removeSource(i)));
      box.append(chip);
    });
    $("smRhythm").value = cfg.rhythm;
    $("smRhythmLabel").textContent = rhythm().label;
    $("smDensity").value = cfg.density;
    $("smDensityLabel").textContent = `fino a ${cfg.density}`;
    $("smVolume").value = Math.round(cfg.volume * 100);
    $("smVolumeLabel").textContent = Math.round(cfg.volume * 100) + "%";
    $("smStart").textContent = active ? "Ferma la regia" : "Avvia la regia";
    $("smStart").classList.toggle("primary", !active);
    $("smStart").classList.toggle("ghost", active);
  }

  const panelVisible = () =>
    $("sidebar").classList.contains("open") && !$("tab-smart").classList.contains("hidden");

  function fmtEta(sec) {
    if (sec < 60) return "meno di un minuto";
    if (sec < 3600) return `circa ${Math.round(sec / 60)} min`;
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return `circa ${h} h ${m} min`;
  }

  // Poll the analysis while somebody can see it: the panel, or the stage
  // while material is still coming in.
  async function pollStatus() {
    clearTimeout(statusT);
    const params = new URLSearchParams();
    for (const s of cfg.sources) params.append("target", s);
    try {
      lastStatus = await api("GET", `/analysis?${params}`);
      renderStatus(lastStatus);
    } catch (e) { /* server busy or gone: try again */ }
    const working = lastStatus && (lastStatus.current || lastStatus.queued);
    if (panelVisible() || (active && working))
      statusT = setTimeout(pollStatus, working ? 2000 : 6000);
  }

  function renderStatus(st) {
    const finished = st.done + st.failed;
    const working = !!(st.current || st.queued);
    const frac = st.batch ? (finished + (st.current ? st.progress : 0)) / st.batch : 0;
    $("smBatchBar").style.width = (working ? frac * 100 : st.batch ? 100 : 0) + "%";
    $("smBatchBar").classList.toggle("paused", st.paused);
    let line;
    if (st.paused && working) line = `In pausa · ${finished} di ${st.batch} video`;
    else if (working) line = `${finished} di ${st.batch} video` + (st.eta != null ? ` · ${fmtEta(st.eta)}` : "");
    else line = st.batch ? `Fatto: ${st.done} video analizzati` : "Nessuna analisi in corso";
    if (st.failed) line += ` · ${st.failed} non riusciti`;
    $("smBatchText").textContent = line;
    $("smFileBar").parentElement.classList.toggle("hidden", !st.current);
    $("smFileBar").style.width = (st.progress * 100) + "%";
    $("smFileText").textContent = st.current ? `Ora: ${st.current.split("/").pop()} · ${Math.round(st.progress * 100)}%` : "";
    $("smLibText").textContent = `Libreria: ${st.library[0]} su ${st.library[1]} video analizzati`;
    $("smPause").textContent = st.paused ? "Riprendi" : "Pausa";
    $("smAll").disabled = st.library[0] >= st.library[1];

    // Coverage on the source chips.
    for (const [i, s] of cfg.sources.entries()) {
      const c = st.coverage?.[s], el = $("smSources").children[i]?.querySelector(".sm-cov");
      if (c && el) { el.textContent = `${c[0]}/${c[1]}`; el.classList.toggle("full", c[0] >= c[1]); }
      else if (c && !el) { renderPanel(); break; }
    }

    // On the stage: a small pill while the sources are still being analysed.
    const cov = Object.values(st.coverage || {});
    const ready = cov.reduce((k, c) => k + c[0], 0), total = cov.reduce((k, c) => k + c[1], 0);
    const pill = $("smPill");
    pill.classList.toggle("hidden", !active || ready >= total);
    pill.innerHTML = `<span class="material-icons-round">${st.paused ? "pause" : "insights"}</span>` +
      `Analisi ${ready}/${total}` + (st.paused ? " · in pausa" : "");
    $("smWaitText").textContent = total
      ? `Analisi dei video: ${ready} di ${total} pronti. La regia parte appena c'è materiale.`
      : "Le cartelle scelte non contengono video.";
  }

  // -------------------------------------------------------------------
  //  Stage controls and drops
  // -------------------------------------------------------------------
  function showBar() {
    const bar = $("smStageBar");
    $("smStageTitle").textContent = cfg.sources.map(scopeLabel).join(" + ");
    bar.classList.add("visible");
    clearTimeout(barT);
    barT = setTimeout(() => bar.classList.remove("visible"), 3500);
  }

  function hover(on) { stage.classList.toggle("drop-hover", on); }

  function init() {
    stage = $("smart-stage");
    try { Object.assign(cfg, clean(JSON.parse(localStorage.getItem(STORE)) || {})); } catch (e) {}
    renderPanel();
    stage.addEventListener("click", e => { if (!e.target.closest("button")) showBar(); });
    $("smEvolve").addEventListener("click", () => { tick(); showBar(); });
    $("smExit").addEventListener("click", () => stop());
    $("smStart").addEventListener("click", () => active ? stop() : start());
    $("smAddOpen").addEventListener("click", () => addSource(navPath));
    $("smSave").addEventListener("click", () => {
      if (!cfg.sources.length) { toast("Aggiungi almeno una cartella alla regia"); return; }
      askText({ title: "Salva la regia", ok: "Salva",
                placeholder: `Regia: ${cfg.sources.map(scopeLabel).join(" + ")}`.slice(0, 60) }, name => {
        const m = { id: newId(), name, created: Date.now(), kind: "smart",
                    smart: { ...cfg }, preset: "auto", tiles: [] };
        mosaicCall("PUT", m, "Regia salvata", "Salva regia", () => mosaicCall("DELETE", m));
      });
    });
    $("smPause").addEventListener("click", async () => {
      await api("POST", "/analysis/pause", { paused: !lastStatus?.paused }).catch(() => {});
      pollStatus();
    });
    $("smAll").addEventListener("click", async () => {
      await api("POST", "/analysis/queue", { targets: [""] }).catch(() => {});
      toast("Analisi di tutta la libreria in coda");
      pollStatus();
    });
    const knob = (id, set) => $(id).addEventListener("input", e => { set(+e.target.value); persist(); renderPanel(); });
    knob("smRhythm", v => { cfg.rhythm = v; });
    knob("smDensity", v => { cfg.density = v; });
    knob("smVolume", v => {
      cfg.volume = v / 100;
      for (const c of cells) for (const x of c.videos) x.volume = cfg.volume;
    });
    window.addEventListener("resize", () => { if (active) layout(); });
  }

  window.addEventListener("load", init);

  return {
    get active() { return active; },
    addSource, start, stop, load, setPaused, hover, pollStatus,
    evolve: () => { if (active) tick(); },
    settings: () => ({ ...cfg, sources: [...cfg.sources] }),
  };
})();
