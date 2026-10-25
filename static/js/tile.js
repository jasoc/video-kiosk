"use strict";

// ---------------------------------------------------------------------
//  Tile: one video slot in the grid, looping its scopes
// ---------------------------------------------------------------------
const scopeLabel = p => p ? p.split("/").pop() : "Tutti i video";

// "a + b", with "×2" when the same scope was dropped twice (more weight).
function scopeTitle(scopes) {
  const n = new Map();
  for (const s of scopes) n.set(s, (n.get(s) || 0) + 1);
  return [...n].map(([s, k]) => scopeLabel(s) + (k > 1 ? ` ×${k}` : "")).join(" + ");
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// {file: [from, to]} as stored in a mosaic, dropping anything malformed.
function cleanRanges(r) {
  const out = {};
  if (r && typeof r === "object")
    for (const [f, v] of Object.entries(r))
      if (Array.isArray(v) && v[1] - v[0] >= MIN_RANGE) out[f] = [+v[0], +v[1]];
  return out;
}

class Tile {
  constructor(contentEl, scopes, opts = {}) {
    // "" = root, folder paths and/or file paths. Several = a mixed tile;
    // the same scope twice simply weighs double.
    this.scopes = scopes.length ? [...scopes] : [""];
    this.mode = opts.mode === "full" ? "full" : "clips";
    this.duration = DURATIONS.includes(opts.duration) ? opts.duration : 20;
    this.zoom = ZOOMS.some(z => z.id === opts.zoom) ? opts.zoom : "fill";
    this.ranges = cleanRanges(opts.ranges);   // file -> [from, to] seconds
    this.skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);  // files left out
    this.volume = typeof opts.volume === "number" ? clamp(opts.volume, 0, 1) : 1;
    this.gen = 0;              // bumped to cancel stale async work
    this.pre = 0;              // bumped to cancel a stale prefetch
    this.loading = false;      // advance() is loading on the hidden element
    this.timer = null;
    this.cropT = null;
    this.crop = null;
    this.clip = null;
    this.next = null;          // { clip, el } prefetched and ready
    this.active = 0;
    this.root = contentEl;

    this.videos = [this.makeVideo(), this.makeVideo()];
    this.spinner = document.createElement("div");
    this.spinner.className = "tile-spinner";
    this.spinner.innerHTML = '<span class="material-icons-round">hourglass_top</span>';

    // --- overlay: title row, timeline row, controls row ---
    this.overlay = document.createElement("div");
    this.overlay.className = "tile-overlay";

    this.title = document.createElement("div");
    this.title.className = "tile-title";
    this.scopeEl = document.createElement("button");
    this.scopeEl.className = "tile-scope";
    this.scopeEl.title = "Modifica il tassello";
    this.scopeEl.innerHTML = '<span class="material-icons-round">tune</span><span></span>';
    this.scopeText = this.scopeEl.lastChild;
    stopDrag(this.scopeEl);
    this.scopeEl.addEventListener("click", e => { e.stopPropagation(); openEditor(this); });
    this.fileEl = document.createElement("span");
    this.fileEl.className = "tile-file";
    this.fileEl.textContent = scopeTitle(this.scopes);
    this.title.append(this.scopeEl, this.fileEl);

    this.tl = document.createElement("div");
    this.tl.className = "tile-tl";
    this.playBtn = tileBtn("pause", () => this.togglePlay());
    this.track = new Track({
      seekable: () => this.mode === "full",
      onStart: () => clearTimeout(this.timer),
      onPreview: t => {
        previewSeek(this.videos[this.active], t);
        this.showOverlay();
      },
      onSeek: t => {
        const v = this.videos[this.active];
        v.currentTime = t;
        if (!v.paused) this.armTimer();
        this.showOverlay();
      },
      onRange: (r, which) => this.setRange(this.clip.file, r, this.clip.dur, which),
    });
    this.timeEl = document.createElement("span");
    this.timeEl.className = "tl-time";
    this.resetBtn = tileBtn("restart_alt", () => this.setRange(this.clip.file, null, this.clip.dur));
    this.resetBtn.title = "Usa tutto il video";
    this.tl.append(this.playBtn, this.track.el, this.timeEl, this.resetBtn);

    const bar = document.createElement("div");
    bar.className = "tile-bar";
    this.durBtn = tilePill(() => this.toggleDurPanel());
    this.zoomBtn = tileBtn("crop", () => this.cycleZoom());
    this.modeBtn = tileBtn("shuffle", () => this.toggleMode());
    const spacer = document.createElement("span");
    spacer.className = "tile-spacer";
    const dup = tileBtn("content_copy", () => duplicateTile(this.root.parentElement));
    dup.title = "Duplica il tassello";
    const skip = tileBtn("skip_next", () => this.advance());
    skip.title = "Prossima clip";
    const close = tileBtn("close", () => removeTile(this.root.parentElement));
    close.title = "Rimuovi";
    bar.append(this.durBtn, this.zoomBtn, this.modeBtn, spacer, dup, skip, close);
    this.overlay.append(this.title, this.tl, bar);

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
    this.root.addEventListener("click", () => {
      if (!this.root.parentElement?._dragged) this.showOverlay();
    });
    this.updateControls();
    this.applyZoom();
    this.advance();
  }

  makeVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    noOverlays(v);
    v.addEventListener("ended", () => {
      if (!paused && !v.loop && v === this.videos[this.active]) this.clipEnd();
    });
    // Keep the timeline live, but only while somebody can see it.
    const live = () => {
      if (v === this.videos[this.active] && !this.track.drag &&
          this.overlay.classList.contains("visible")) this.renderTimeline();
    };
    for (const ev of ["timeupdate", "play", "pause"]) v.addEventListener(ev, live);
    return v;
  }

  // The tile plays exactly one file: full mode can loop it in place.
  isFile(clip) {
    return !!clip && this.scopes.length === 1 && clip.file === this.scopes[0];
  }

  // The selection that applies to `clip`, clamped to its length, or null.
  rangeFor(clip) {
    const r = clip && this.ranges[clip.file];
    if (!r) return null;
    const a = clamp(r[0], 0, clip.dur), b = clamp(r[1], 0, clip.dur);
    return b - a >= MIN_RANGE ? [a, b] : null;
  }

  showOverlay() {
    this.overlay.classList.add("visible");
    this.root.parentElement?.classList.add("active");   // resize corners
    this.renderTimeline();
    clearTimeout(this.overlayT);
    this.overlayT = setTimeout(() => {
      this.overlay.classList.remove("visible");
      this.root.parentElement?.classList.remove("active");
      this.durPanel.classList.remove("visible");
    }, 5000);
  }

  updateControls() {
    this.modeBtn.querySelector("span").textContent =
      this.mode === "clips" ? "shuffle" : "repeat";
    this.modeBtn.title = this.mode === "clips" ? "Clip casuali" : "Video interi";
    const z = ZOOMS.find(z => z.id === this.zoom);
    this.zoomBtn.querySelector("span").textContent = z.icon;
    this.zoomBtn.title = z.title;
    this.zoomBtn.classList.toggle("on", this.zoom === "smart");
    this.durBtn.textContent = this.duration + "s";
    this.durBtn.style.display = this.mode === "clips" ? "" : "none";
    this.durPanel.querySelectorAll(".dur-opt").forEach(b =>
      b.classList.toggle("active", +b.dataset.dur === this.duration));
    this.renderTimeline();
  }

  // Title: the scope chip (tap → tile editor) and the file playing now.
  // A single-file tile shows the file name in the chip only.
  updateTitle(clip) {
    const parts = clip.file.split("/");
    const name = parts.pop();
    const whole = this.scopes.length === 1 && !this.scopes[0];
    this.scopeText.textContent = this.isFile(clip) ? name
      : whole ? (parts.length ? parts[parts.length - 1] : "Libreria")
      : scopeTitle(this.scopes);
    this.fileEl.textContent = name;
    this.fileEl.style.display = this.isFile(clip) ? "none" : "";
  }

  // Timeline of the clip on screen: handles to cut it (any mode, any
  // scope), plus scrubbing and play/pause in full mode.
  renderTimeline() {
    const clip = this.clip;
    this.tl.style.display = clip ? "" : "none";
    if (!clip) return;
    const v = this.videos[this.active];
    this.track.set(clip.dur || v.duration, this.rangeFor(clip), v.currentTime);
    this.playBtn.style.display = this.mode === "full" ? "" : "none";
    this.playBtn.querySelector("span").textContent = v.paused ? "play_arrow" : "pause";
    this.resetBtn.style.display = this.rangeFor(clip) ? "" : "none";
    this.timeEl.textContent = this.track.label();
  }

  // Store the cut of one file (null or the whole file = no cut).
  setRange(file, range, dur, which = 0) {
    remember("Taglio");
    if (range && (range[0] > 0.1 || range[1] < dur - 0.1))
      this.ranges[file] = [Math.round(range[0] * 100) / 100, Math.round(range[1] * 100) / 100];
    else
      delete this.ranges[file];
    // A prefetched clip of the same file may now start outside the cut.
    if (this.next?.clip.file === file) this.refetch();
    this.recut(file, which);
  }

  // If `file` is on screen, re-cut its window in place: same element, no
  // reload. `which` = the handle just moved, so ending on the end handle
  // lets you hear the cut point.
  recut(file, which = 0) {
    const clip = this.clip;
    if (!clip || clip.file !== file) return;
    const v = this.videos[this.active];
    const r = this.rangeFor(clip);
    const [a, b] = r || [0, clip.dur];
    if (this.mode === "full") {
      clip.start = a;
      clip.length = b - a;
      if (this.isFile(clip)) v.loop = !r;
    } else {
      clip.length = Math.min(this.duration, b - a);
      clip.start = which === 1 ? b - clip.length : a;
    }
    v.currentTime = which === 1
      ? Math.max(clip.start, clip.start + clip.length - 3) : clip.start;
    if (!v.paused) this.armTimer();
    this.showOverlay();
  }

  // Drop the prefetched clip (it may no longer fit) and fetch another.
  refetch() {
    this.next = null;
    this.pre++;
    if (this.clip && !this.loading && !(this.mode === "full" && this.isFile(this.clip)))
      this.prefetch();
  }

  // Can this tile still play `file`? (inside a scope and not left out)
  plays(file) {
    return !this.skip.has(file) &&
      this.scopes.some(s => !s || file === s || file.startsWith(s + "/"));
  }

  // Scope / file list changed: move on if what is on screen is gone.
  rescoped() {
    if (!this.clip || !this.plays(this.clip.file)) {
      this.next = null;
      this.advance();
    } else {
      this.refetch();
    }
    this.updateTitle(this.clip || { file: "" });
  }

  removeScope(i) {
    if (this.scopes.length < 2) return;
    remember("Togli dal mix");
    this.scopes.splice(i, 1);
    this.rescoped();
  }

  toggleSkip(file) {
    remember(this.skip.has(file) ? "Includi video" : "Escludi video");
    if (!this.skip.delete(file)) this.skip.add(file);
    this.rescoped();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    for (const el of this.videos) el.volume = this.volume;
  }

  // Undo of settings that need no reload: zoom, volume, cuts.
  retune(td) {
    this.zoom = ZOOMS.some(z => z.id === td.zoom) ? td.zoom : "fill";
    this.setVolume(typeof td.volume === "number" ? td.volume : 1);
    this.ranges = cleanRanges(td.ranges);
    this.updateControls();
    this.refreshCrop();
    if (this.clip) this.recut(this.clip.file);
    if (this.next) this.refetch();
  }

  togglePlay() {
    const v = this.videos[this.active];
    if (v.paused) {
      v.play().catch(() => {});
      this.armTimer();
    } else {
      v.pause();
      clearTimeout(this.timer);
    }
    this.showOverlay();
  }

  // Dropping another library entry on this tile mixes it in. Dropping one
  // that is already there is allowed: it just weighs double.
  addScope(scope) {
    this.scopes.push(scope);
    this.skip.delete(scope);
    this.next = null;
    this.advance();
    toast(`Mescolati: ${scopeTitle(this.scopes)}`);
  }

  // Another tile was dropped on this one: take its scopes, plus its cuts
  // and left-out files where they don't contradict ours.
  mergeFrom(o) {
    const had = f => this.plays(f);
    for (const f of o.skip) if (!had(f)) this.skip.add(f);
    for (const [f, r] of Object.entries(o.ranges)) if (!this.ranges[f]) this.ranges[f] = r;
    this.scopes.push(...o.scopes);
    this.next = null;
    this.advance();
    toast(`Mescolati: ${scopeTitle(this.scopes)}`);
  }

  // Everything needed to rebuild this tile elsewhere (duplicate, mosaic).
  settings() {
    return { scopes: [...this.scopes], skip: [...this.skip], mode: this.mode,
             duration: this.duration, zoom: this.zoom, volume: this.volume,
             ranges: { ...this.ranges } };
  }

  toggleMode() {
    remember("Modalità");
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
    remember("Durata clip");
    this.duration = d;
    this.durPanel.classList.remove("visible");
    this.updateControls();
    this.showOverlay();
    this.next = null;          // applies from the next clip
    this.advance();
  }

  cycleZoom() {
    remember("Zoom");
    const i = ZOOMS.findIndex(z => z.id === this.zoom);
    this.zoom = ZOOMS[(i + 1) % ZOOMS.length].id;
    this.updateControls();
    this.showOverlay();
    this.refreshCrop();
  }

  // Re-detect the content box of the current clip (smart zoom only).
  refreshCrop() {
    clearTimeout(this.cropT);
    this.crop = null;
    if (this.zoom !== "smart" || !this.clip) {
      this.applyZoom();
      return;
    }
    const gen = this.gen, file = this.clip.file;
    const attempt = left => {
      if (gen !== this.gen) return;
      this.crop = detectCrop(this.videos[this.active], file);
      this.applyZoom();
      if (!this.crop && left > 0)
        this.cropT = setTimeout(() => attempt(left - 1), 700);
    };
    attempt(3);
  }

  applyZoom() {
    const front = this.videos[this.active];
    for (const v of this.videos) {
      v.style.objectFit = this.zoom === "fill" ? "cover" : "contain";
      v.style.transform = "";
    }
    if (this.zoom !== "smart" || !this.crop) return;
    const box = this.crop;
    const tw = this.root.clientWidth, th = this.root.clientHeight;
    const vw = front.videoWidth, vh = front.videoHeight;
    if (!tw || !th || !vw || !vh) return;
    // object-fit: contain puts the frame on screen at scale s; blow the
    // content box up until it covers the tile and re-centre it.
    const s = Math.min(tw / vw, th / vh);
    const k = clamp(Math.max(tw / (box.w * vw * s), th / (box.h * vh * s)), 1, 8);
    const dx = (box.x + box.w / 2 - 0.5) * vw * s;
    const dy = (box.y + box.h / 2 - 0.5) * vh * s;
    front.style.transform = `translate(${-k * dx}px, ${-k * dy}px) scale(${k})`;
  }

  async fetchClip() {
    const params = new URLSearchParams({ duration: this.duration });
    for (const s of this.scopes) params.append("target", s);
    for (const f of this.skip) params.append("skip", f);
    const res = await fetch(`/random?${params}`);
    if (!res.ok) throw new Error("no clips");
    const clip = await res.json();
    // A cut narrows the window: full mode plays exactly it, clips mode
    // draws its in-point from inside it.
    const r = this.rangeFor(clip);
    const [a, b] = r || [0, clip.dur];
    if (this.mode === "full") {
      clip.start = a;
      clip.length = b - a;
    } else if (r) {
      clip.length = Math.min(this.duration, b - a);
      clip.start = a + Math.random() * (b - a - clip.length);
    }
    return clip;
  }

  // Load clip into el and resolve when it can play from clip.start.
  prepare(el, clip) {
    return new Promise((resolve, reject) => {
      const gen = this.gen;
      el._done?.(false);                 // a previous load on el settles as stale
      let settled = false;
      const done = el._done = (ok) => {
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
      el.src = videoUrl(clip.file);
      el.load();
    });
  }

  // Show the next clip: use the prefetched one if ready, otherwise load.
  async advance() {
    const gen = ++this.gen;
    clearTimeout(this.timer);
    let clip, el, fails = 0;

    if (this.next) {
      ({ clip, el } = this.next);
      this.next = null;
      this.loading = false;
    } else {
      this.spinner.classList.add("visible");
      this.loading = true;
      while (true) {
        try {
          clip = await this.fetchClip();
          el = this.videos[1 - this.active];
          await this.prepare(el, clip);
          break;
        } catch (e) {
          if (gen !== this.gen) return;
          if (e.message === "stale") { this.loading = false; return; }
          if (++fails >= 2) libraryTrouble();
          await new Promise(r => setTimeout(r, 2000));
          if (gen !== this.gen) return;
        }
      }
    }
    if (gen !== this.gen) return;
    this.loading = false;
    this.spinner.classList.remove("visible");

    const old = this.videos[this.active];
    this.active = this.videos.indexOf(el);
    this.clip = clip;
    el.classList.add("front");
    old.classList.remove("front");
    old.pause();

    // A full-mode tile on a single file loops in place: natively when it
    // plays the whole file (seamless, no timers), by seeking back when it
    // is cut. Either way no prefetch traffic.
    const self = this.mode === "full" && this.isFile(clip);
    el.loop = self && !this.rangeFor(clip);

    el.muted = !audible();
    el.volume = this.volume;
    if (!paused) {
      el.play().catch(() => {});
      this.armTimer();
    }
    this.updateTitle(clip);
    this.renderTimeline();
    this.refreshCrop();
    if (!self) this.prefetch();
  }

  armTimer() {
    clearTimeout(this.timer);
    const v = this.videos[this.active];
    if (!this.clip || v.loop) return;
    const remaining = (this.clip.start + this.clip.length) - v.currentTime;
    this.timer = setTimeout(() => this.clipEnd(), Math.max(0.3, remaining) * 1000);
  }

  // The current window is over: a full-mode single file loops its cut in
  // place, everything else moves on to the next clip.
  clipEnd() {
    const v = this.videos[this.active];
    if (this.mode !== "full" || !this.isFile(this.clip)) {
      this.advance();
      return;
    }
    // The timer runs on wall time; after a stall the video may lag behind.
    if (v.currentTime < this.clip.start + this.clip.length - 0.3 && !v.ended) {
      this.armTimer();
      return;
    }
    v.currentTime = this.clip.start;
    v.play().catch(() => {});
    this.armTimer();
  }

  async prefetch() {
    const gen = this.gen, pre = ++this.pre;
    try {
      const clip = await this.fetchClip();
      if (gen !== this.gen || pre !== this.pre) return;
      const el = this.videos[1 - this.active];
      await this.prepare(el, clip);
      if (gen === this.gen && pre === this.pre) this.next = { clip, el };
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
    clearTimeout(this.cropT);
    for (const v of this.videos) {
      v.pause();
      v.removeAttribute("src");
      v.load();                 // release decoder + buffers
    }
    this.root.replaceChildren();
  }
}

// In a mosaic ask the server for a low-res proxy: six full-quality
// streams are what makes a tablet stutter. A single tile (the only one
// with audio) always gets the original.
const encodePath = file => file.split("/").map(encodeURIComponent).join("/");

function videoUrl(file) {
  // getGridItems() (not tiles.size) so a tile loading its very first clip
  // already counts itself. Proxies carry audio, so this holds with mosaic
  // audio on as well.
  const many = grid.getGridItems().length > 1;
  return `/video/${encodePath(file)}${many ? "?q=low" : ""}`;
}

// The tablet's browser draws picture-in-picture and cast buttons on top of
// videos, where they steal the taps meant for our controls. Turn them off.
function noOverlays(v) {
  v.disablePictureInPicture = true;
  v.disableRemotePlayback = true;
  v.setAttribute("disablepictureinpicture", "");
  v.setAttribute("disableremoteplayback", "");
  v.setAttribute("controlslist", "nodownload nofullscreen noremoteplayback noplaybackrate");
}

// Range sliders paint their filled part from --fill (0–100%).
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty("--fill", ((el.value - min) / (max - min)) * 100 + "%");
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
