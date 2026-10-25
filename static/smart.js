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
  const orient = a => a > 1.15 ? "h" : a < 0.87 ? "v" : "s";
  // A vertical clip in a horizontal frame, or the other way round.
  const clash = (a, b) => {
    const x = orient(a), y = orient(b);
    return x !== "s" && y !== "s" && x !== y;
  };

  // Best shot for the phase. `frame`: aspect of the cell it goes in (a
  // mismatch costs points); `highlight`: that cell stands out, so a clip
  // of the opposite orientation is not allowed at all; `want`: only
  // shots of that orientation (used to compare a vertical and a
  // horizontal candidate). The strict rules are dropped only when no
  // shot satisfies them.
  function chooseShot({ frame = null, highlight = false, want = null } = {}) {
    if (!shots.length) return null;
    const playing = new Set([...cells].map(c => c.clip?.file));
    const sample = shots.length <= 300 ? shots
      : Array.from({ length: 300 }, () => shots[Math.floor(Math.random() * shots.length)]);
    for (const strict of want ? [true] : [true, false]) {
      let best = null, bestScore = -Infinity;
      for (const s of sample) {
        if (strict && want && clash(want, s.aspect)) continue;
        if (strict && highlight && frame && clash(frame, s.aspect)) continue;
        let score = -2 * Math.abs(s.energy - phase.energy);
        if (phase.hue !== null) score -= 1.2 * s.sat * hueDist(s.hue, phase.hue) / Math.PI;
        if (frame) score -= 1.5 * fitCost(frame, s.aspect);
        if (playing.has(s.file)) score -= 2.5;
        if (recent.includes(s.id)) score -= 2;
        score += Math.random() * 0.7;                // a little variety
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (best) return best;
    }
    return null;
  }

  // The clip actually played from a shot: the whole shot, or a window of
  // a shot longer than the rhythm allows.
  function clipOf(s) {
    recent.push(s.id);
    if (recent.length > 60) recent.shift();
    const len = s.b - s.a, max = rhythm().max;
    const start = s.a + (len > max ? Math.random() * (len - max) : 0);
    return { file: s.file, start, length: Math.min(len, max), aspect: s.aspect, crop: s.crop };
  }

  // Next clip for a cell, chosen for its current frame.
  function pickFor(cell) {
    const r = cell.rect;
    const s = r ? chooseShot({ frame: r.w / r.h, highlight: standsOut(r, cells.size) })
                : chooseShot();
    return s && clipOf(s);
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
      this.pending = null;       // aspect of the clip being loaded, for planning
      stage.append(this.el);
    }

    makeVideo() {
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.muted = true;
      noOverlays(v);
      return v;
    }

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
      const clip = pickFor(this);
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
      // Chosen for the frame this cell had then: drop it if the cell now
      // stands out and the clip's orientation is the wrong one.
      if (n && this.rect && standsOut(this.rect, cells.size) &&
          clash(this.rect.w / this.rect.h, n.clip.aspect)) n = null;
      const gen = ++this.gen;
      if (!n) {
        const clip = pickFor(this);
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
  //
  //  The director never places cells by a local rule: it builds candidate
  //  trees (split this leaf or that one, either way, remove this cell or
  //  that one), lets optimize() tune every split's direction and ratio,
  //  and keeps the candidate with the lowest cost(). cost() is where the
  //  taste lives, in plain numbers.
  // -------------------------------------------------------------------
  const RATIOS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
  const HIGHLIGHT_SHARE = 0.4;   // a cell this much of the stage stands out...
  const HIGHLIGHT_REL = 1.5;     // ...and so does one 1.5× the average cell

  const stageSize = () => ({ W: stage.clientWidth || innerWidth, H: stage.clientHeight || innerHeight });

  function standsOut(r, n) {
    const { W, H } = stageSize(), share = (r.w * r.h) / (W * H);
    return share >= HIGHLIGHT_SHARE || share * n >= HIGHLIGHT_REL;
  }

  const leavesOf = (n, out = []) => {
    if (n.cell) out.push(n); else { leavesOf(n.a, out); leavesOf(n.b, out); }
    return out;
  };
  const splitsOf = (n, out = []) => {
    if (!n.cell) { out.push(n); splitsOf(n.a, out); splitsOf(n.b, out); }
    return out;
  };
  const clone = n => n.cell ? { cell: n.cell }
    : { dir: n.dir, ratio: n.ratio, a: clone(n.a), b: clone(n.b) };

  // Leaves of `tree` with their rect on the stage.
  function rects(tree) {
    const { W, H } = stageSize(), out = [];
    const go = (n, x, y, w, h) => {
      if (n.cell) return out.push({ cell: n.cell, r: { x, y, w, h } });
      if (n.dir === "v") {
        const wa = w * n.ratio;
        go(n.a, x, y, wa, h); go(n.b, x + wa, y, w - wa, h);
      } else {
        const ha = h * n.ratio;
        go(n.a, x, y, w, ha); go(n.b, x, y + ha, w, h - ha);
      }
    };
    if (tree) go(tree, 0, 0, W, H);
    return out;
  }

  // How bad a layout is. Each term is one thing that looks wrong.
  function cost(tree) {
    const { W, H } = stageSize(), leaves = rects(tree), n = leaves.length;
    // The stage itself may be wide (a long tablet): a cell may be as wide
    // as the stage, not wider.
    const maxA = Math.max(1.9, W / H + 0.05), minA = 0.45;
    const minSide = Math.max(MIN_CELL_PX, H * 0.2);
    let c = 0;
    for (const { cell, r } of leaves) {
      const a = r.w / r.h, share = (r.w * r.h) / (W * H), rel = share * n;
      // Long strips and thin columns.
      if (a > maxA) c += 1 + 4 * Math.log(a / maxA);
      if (a < minA) c += 1 + 4 * Math.log(minA / a);
      // Crumbs: a cell much smaller than the average, or too small to read.
      if (rel < 0.45) c += 0.5 + 4 * (0.45 - rel);
      const side = Math.min(r.w, r.h);
      if (side < minSide) c += 2 + 6 * (1 - side / minSide);
      // The clip against its frame: matters more the bigger the frame,
      // and a crossed orientation in a cell that stands out is a no.
      const ca = cell.clip?.aspect ?? cell.pending ?? 16 / 9;
      c += fitCost(a, ca) * (0.3 + rel);
      if (clash(a, ca) && standsOut(r, n)) c += 6;
      // Continuity: a cell on screen shouldn't jump for a small gain.
      const o = cell.rect;
      if (o) c += 0.8 * (Math.abs(r.x - o.x) + Math.abs(r.y - o.y) +
                         Math.abs(r.w - o.w) + Math.abs(r.h - o.h)) / (W + H);
    }
    return c;
  }

  // Local search: try every direction and ratio of every split, keep what
  // lowers the cost, until a pass changes nothing. Six cells at most make
  // this a few hundred evaluations of cost(): nothing.
  function optimize(tree) {
    let best = cost(tree);
    for (let pass = 0; pass < 4; pass++) {
      let better = false;
      for (const s of splitsOf(tree)) {
        let keep = [s.dir, s.ratio];
        for (const dir of ["v", "h"]) {
          for (const ratio of RATIOS) {
            s.dir = dir;
            s.ratio = ratio;
            const c = cost(tree);
            if (c < best - 1e-6) { best = c; keep = [dir, ratio]; better = true; }
          }
        }
        [s.dir, s.ratio] = keep;
      }
      if (!better) break;
    }
    return best;
  }

  // Every tree with `cell` added: split any leaf, either way, either side.
  function withCell(tree, cell) {
    if (!tree) return [{ cell }];
    const out = [], count = leavesOf(tree).length;
    for (let k = 0; k < count; k++) {
      for (const dir of ["v", "h"]) {
        for (const first of [true, false]) {
          const t = clone(tree), leaf = leavesOf(t)[k];
          const old = { cell: leaf.cell }, fresh = { cell };
          delete leaf.cell;
          Object.assign(leaf, { dir, ratio: 0.5, a: first ? fresh : old, b: first ? old : fresh });
          out.push(t);
        }
      }
    }
    return out;
  }

  // `tree` without `cell`: its sibling takes the parent's space.
  function without(tree, cell) {
    if (tree.cell) return tree.cell === cell ? null : tree;
    const a = without(tree.a, cell), b = without(tree.b, cell);
    if (!a) return b;
    if (!b) return a;
    tree.a = a;
    tree.b = b;
    return tree;
  }

  // Optimise every candidate, return the cheapest {tree, cost}.
  function cheapest(trees) {
    let best = null;
    for (const t of trees) {
      const c = optimize(t);
      if (!best || c < best.cost) best = { tree: t, cost: c };
    }
    return best;
  }

  function layout() {
    for (const { cell, r } of rects(root))
      cell.place({ x: r.x + GAP, y: r.y + GAP, w: r.w - 2 * GAP, h: r.h - 2 * GAP });
    // Smart crop depends on the final size: redo it once the move ends.
    setTimeout(() => { for (const c of cells) c.fit(); }, FADE_MS + 100);
    // A cell that grew into the spotlight with a clip of the wrong
    // orientation gets a fitting one now, not when its shot ends.
    for (const c of cells) {
      const frame = c.rect && c.rect.w / c.rect.h;
      if (c.clip && frame && standsOut(c.rect, cells.size) && clash(frame, c.clip.aspect) &&
          shots.some(x => !clash(frame, x.aspect)))
        c.advance();
    }
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

  // Add a cell. What fits the stage now, a horizontal or a vertical clip?
  // Plan both, with every possible insertion, and keep the cheapest.
  async function grow() {
    if (busy || !active) return;
    busy = true;
    let pick = null;
    for (const want of [16 / 9, 9 / 16]) {
      const s = chooseShot({ want });
      if (!s || pick?.shot === s) continue;
      const plan = cheapest(withCell(root && clone(root), { pending: s.aspect }));
      const c = plan.cost + Math.random() * 0.3;
      if (!pick || c < pick.cost) pick = { shot: s, cost: c };
    }
    // Adding would make the stage clearly worse: skip this move.
    if (!pick || (root && pick.cost - cost(root) > 8)) { busy = false; return; }

    const cell = new Cell();
    cell.pending = pick.shot.aspect;
    const clip = clipOf(pick.shot);
    try {
      const el = await cell.load(clip);
      if (!active) throw new Error("stopped");
      // Re-plan with the real cell: the stage may have moved meanwhile.
      root = cheapest(withCell(root && clone(root), cell)).tree;
      cells.add(cell);
      cell.show(clip, el);
      layout();
      requestAnimationFrame(() => cell.el.classList.add("in"));
    } catch (e) {
      cell.destroy();
    }
    busy = false;
  }

  // Remove the cell whose departure leaves the best stage (older cells
  // go first when it's a close call).
  function shrink() {
    const list = [...cells];
    let best = null;
    list.forEach((cell, i) => {
      const t = without(clone(root), cell);
      const c = (t ? optimize(t) : 0) - 0.4 * (list.length - i) / list.length;
      if (!best || c < best.c) best = { c, cell, t };
    });
    if (!best) return;
    const { cell, t } = best;
    root = t;
    cells.delete(cell);
    cell.el.classList.remove("in");
    cell.el.classList.add("out");
    layout();
    setTimeout(() => cell.destroy(), FADE_MS);
  }

  // Re-plan the cells on stage: their clips change shape over time.
  function settle() {
    if (!root) return false;
    const t = clone(root);
    if (optimize(t) >= cost(root) - 0.05) return false;
    root = t;
    layout();
    return true;
  }

  // A small random breath of one split, kept only if the stage stays good.
  function nudge() {
    if (!root) return false;
    const t = clone(root), sp = splitsOf(t);
    if (!sp.length) return false;
    const s = sp[Math.floor(Math.random() * sp.length)];
    s.ratio = clamp(s.ratio + (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.05), 0.3, 0.7);
    if (cost(t) > cost(root) + 0.4) return false;
    root = t;
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
      else if (!settle() && !(Math.random() < 0.5 && nudge())) {
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
    for (const id of ["smRhythm", "smDensity", "smVolume"]) paintRange($(id));
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
    const working = lastStatus && (lastStatus.current.length || lastStatus.queued);
    if (panelVisible() || (active && working))
      statusT = setTimeout(pollStatus, working ? 2000 : 6000);
  }

  function renderStatus(st) {
    const finished = st.done + st.failed;
    const working = !!(st.current.length || st.queued);
    const inFlight = st.current.reduce((k, c) => k + c.progress, 0);
    const frac = st.batch ? (finished + inFlight) / st.batch : 0;
    $("smBatchBar").style.width = (working ? frac * 100 : st.batch ? 100 : 0) + "%";
    $("smBatchBar").classList.toggle("paused", st.paused);
    let line;
    if (st.paused && working) line = `In pausa · ${finished} di ${st.batch} video`;
    else if (working) line = `${finished} di ${st.batch} video` + (st.eta != null ? ` · ${fmtEta(st.eta)}` : "");
    else line = st.batch ? `Fatto: ${st.done} video analizzati` : "Nessuna analisi in corso";
    if (st.failed) line += ` · ${st.failed} non riusciti`;
    $("smBatchText").textContent = line;
    // One thin bar per file in progress (several at "massima" speed).
    const files = $("smFiles");
    files.replaceChildren();
    for (const c of st.current) {
      const row = document.createElement("div");
      row.className = "sm-file";
      row.innerHTML = `<div class="sm-bar thin"><div style="width:${c.progress * 100}%"></div></div>` +
        `<span class="sm-line dim">${escapeHtml(c.file.split("/").pop())} · ${Math.round(c.progress * 100)}%</span>`;
      files.append(row);
    }
    for (const b of document.querySelectorAll(".sm-speed button"))
      b.classList.toggle("active", b.dataset.speed === st.speed);
    $("smSpeedHint").textContent = st.speed === "high"
      ? `${st.workers} video alla volta, priorità normale: più veloce, il server lavora di più.`
      : "Un video alla volta, a bassa priorità: il server resta tranquillo.";
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
    for (const b of document.querySelectorAll(".sm-speed button"))
      b.addEventListener("click", async () => {
        await api("POST", "/analysis/speed", { speed: b.dataset.speed }).catch(() => {});
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
