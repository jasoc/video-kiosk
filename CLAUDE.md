# CLAUDE.md

Guidance for Claude Code (and any other LLM/agent) working in this repository.

---

## 1. What this project is

`video-kiosk` is a **single-page video wall** that runs on a wall-mounted tablet in a
physical atelier. Visitors touch a folder tree and the app plays an endless loop of
random clips from that folder, or lets them drag videos onto the canvas to build a
mosaic (split view) of several videos playing at once.

It is a **toy for a physical space**, not a product. There is no auth, no database, no
build step, no test suite, and no telemetry. The only shared state is the saved mosaics,
kept as plain JSON files on a volume. It is deployed as
a single Docker container with a host directory of videos bind-mounted into it.

### Design philosophy — read this before adding anything

- **Minimal by mandate.** The owner has explicitly stated this app will not gain more
  features and is not being sold. When in doubt, delete rather than add.
- **Performance over features.** The target hardware is a tablet, the library can hold
  many clips across deeply nested folders. Anything that costs memory or blocks the UI
  is a bug, not a tradeoff.
- **No build tooling.** Plain HTML/CSS/JS served statically, plain Flask. Do not
  introduce npm, bundlers, frameworks, or a Python dependency beyond Flask without an
  explicit request.
- **Vanilla first.** The only third-party frontend library is GridStack, used purely
  as the mosaic's layout engine (its own drag and resize are disabled). Google Fonts + Material Icons come from a CDN.

---

## 2. File map

| File | Role |
|---|---|
| `app.py` | Flask routes only (~120 lines): static files, tree, video bytes, random clip descriptors, saved mosaics. |
| `library.py` | Library scan (`all_videos`, `build_tree`) and `ffprobe` metadata (`probe`). Owns the two metadata caches. |
| `mosaics.py` | Saved mosaics (and saved regie): one JSON file per mosaic under `DATA_DIR/mosaics`, atomic writes. |
| `analysis.py` | Regia: background analysis of each video (orientation, shots, motion, brightness, colour) with ffmpeg, one JSON per file under `DATA_DIR/analysis`. |
| `proxy.py` | ffmpeg on the server: low-res proxies for mosaics (one background worker thread) and library thumbnails. All output on disk. |
| `static/index.html` | Full DOM skeleton. All UI elements exist up-front; JS only fills the tree, the mosaic list, and the grid. |
| `static/script.js` | Mosaic client logic: `Tile` playback engine, GridStack management, layout presets, saved mosaics, library, drag interaction. |
| `static/smart.js` | The regia (smart mosaic): its own stage, cells, layout tree and director. Loaded after `script.js`, whose helpers it uses (section 4.12). |
| `static/style.css` | All styling. Dark, hairline-bordered, "enterprise minimal". |
| `Dockerfile` | `python:3.12-alpine` + `ffmpeg` (needed for `ffprobe`). |
| `compose.yaml` | Local dev: builds the image, bind-mounts the repo for live editing. |
| `compose-ghcr.yaml` | Production: runs `${KIOSK_IMAGE:-ghcr.io/jasoc/video-kiosk:latest}`. |
| `.github/workflows/` | `ci.yml` (syntax checks) and `docker-publish.yml` (image channels on GHCR), see section 9. |

The app does **not** organise the library: there is no file manager. Videos are moved,
renamed and deleted outside the app (an earlier in-app file manager was removed).

**UI copy is in Italian. Code, comments, and documentation are in English.** Keep this
split — user-visible strings in `index.html` and in `script.js` (button titles, toasts,
preset labels) must stay Italian.

---

## 3. Backend (`app.py` + `library.py` + `mosaics.py` + `proxy.py`)

### Endpoints

| Route | Returns |
|---|---|
| `GET /` | `static/index.html` |
| `GET /tree` | Nested JSON of the library: `{type: "dir"\|"file", name, path, children?}`. Empty directories are listed; dot-directories are skipped. Paths are relative to `ROOT_DIR` and always use `/` separators. |
| `GET /video/<path>[?q=low]` | The video file, **streamed with HTTP Range support** (`conditional=True` → `206 Partial Content`). With `q=low`, a ready proxy if one exists, otherwise the original (and a proxy is queued). |
| `GET /thumb/<path>` | A small JPEG frame of a video (10% in), for the library grid. Built on first request, cached on disk, `404` if ffmpeg fails. |
| `GET /random?target=<path>[&target=<path>…]&duration=<sec>` | `{file, start, length, dur}` — a random video plus a random in-point. Each `target` may be `""` (whole library), a folder path, or an exact file path; with several (a mixed tile) the server picks a target first, then a file in it, so a small folder is not drowned by a big one. Targets with no videos are ignored. `404` if none matches or the pick vanished from disk, which makes the client refresh its tree. |
| `GET /analysis?target=…` | Analysis worker state (`current`, `progress`, `queued`, `batch`/`done`/`failed`, `eta`, `paused`), `coverage` `[ready, total]` per target and for the whole `library`. |
| `POST /analysis/queue` `{targets}` | Queues the not-yet-analysed videos of those scopes, ahead of the rest (`[""]` = the whole library). |
| `POST /analysis/pause` `{paused}` | Pauses / resumes the workers; pausing kills the running ffmpegs and requeues those files. |
| `POST /analysis/speed` `{speed}` | `"low"` (default) or `"high"`, kept in `DATA_DIR/analysis-settings.json`. |
| `GET /smart/pool?target=…` | The analyses of the ready videos of those scopes (a random sample of `POOL_MAX` at most). |
| `GET /mosaics` | All saved mosaics, oldest first. |
| `PUT /mosaics/<id>` | Creates or overwrites one mosaic (last write wins). |
| `DELETE /mosaics/<id>` | Deletes one saved mosaic (never anything in the library). |

The `/mosaics` routes answer `{error}` with `400`/`500` on failure; the error string is
user-visible, hence Italian. **No route writes to or deletes from the video library, and
none must** — the kiosk only reads it.

### Configuration

`VIDEOS_DIR` env var, default `/app/videos`. In Docker the host video directory is
bind-mounted there (read-only would be fine). `PROXY_DIR`, default `/app/proxies`, holds
the transcoded proxies and thumbnails and is a throwaway volume. `DATA_DIR`, default
`/app/data`, holds the saved mosaics and the video analyses and is a volume worth
keeping (analysing a big library takes hours).

### Memory discipline — the most important rule in this repo

An earlier version of this app **read every video file fully into a Python dict** as a
"preload cache", keyed by relative path, freed only when a client called
`/session/end`. That endpoint relied on the browser's `onbeforeunload`, which on a
kiosk tablet essentially never fires. The result was unbounded server memory growth —
the bug that motivated the rewrite.

**Never reintroduce a server-side cache of video bytes.** The OS page cache already
caches hot files for free, and `send_from_directory(..., conditional=True)` lets the
browser fetch only the byte ranges it actually plays. Measured result: container RSS
stays flat (~22 MiB) across hundreds of requests.

Only **metadata** is cached in memory, and it is bounded by the size of the library,
not by video bytes:

- `_list_cache` — the flat list of relative video paths, refreshed at most every
  `LIST_TTL` (30 s), and invalidated immediately by `library.invalidate()` when a pick
  turns out to have vanished from disk. This exists so `/random` does not `os.walk` the
  tree on every call.
- `_meta_cache` — `{(abspath, mtime): {dur, width, height}}` populated by `ffprobe`.
  `ffprobe` is slow (subprocess spawn), so this must stay.

The same rule governs `proxy.py`: proxies are **files on disk**, produced by one
background worker thread and served with `send_from_directory(..., conditional=True)`.
Never buffer a transcode in memory, and never transcode inside a request. The one
deliberate exception is a **thumbnail**: a single-frame grab (a fraction of a second),
built inside the `/thumb` request, at most `THUMB_JOBS` at a time (semaphore), cached
under `PROXY_DIR/thumbs` keyed on size+mtime like proxies.

`analysis.py` follows the same discipline, with a speed the user picks in the UI
(`SPEEDS`): **low** (default) = one file at a time, ffmpeg under `nice -n 15` with 2
threads; **high** = up to `MAX_WORKERS` (half the cores, max 4) files at once at normal
priority, for the first pass over a big library. `MAX_WORKERS` threads exist, worker
*i* only runs while the speed allows *i + 1* files (so wake them with `notify_all()`).
Either way ffmpeg decodes with `-skip_loop_filter all` at `SAMPLE_FPS` and 160 px wide,
results as files on disk. In memory there is only a queue of paths and a few counters. Analyses
are named by `library.file_key()` (size + mtime), like proxies and thumbnails, so a
rename doesn't redo the work and an edited file does.

Both are guarded by `threading.Lock` because Flask runs with `threaded=True`.

### Path safety

`/random` resolves `target` **against the cached video list** (exact match or `path/`
prefix), never by joining user input onto the filesystem. `/video` relies on
`send_from_directory`, which rejects traversal outside the served root. Anything that
hands a client path to ffmpeg (`proxy.low_res()`, `proxy.thumb()`) first checks
`library.is_video()` (a set built with the cached list). Keep these properties if you
touch these routes.

`mosaics.py` is the only module that writes to disk (besides the proxy worker). Mosaic
ids become file names, so they are matched against `^[A-Za-z0-9_-]{1,40}$` before any
path is built. Writes go through a temp file + `os.replace()`, so a reader never sees a
half-written mosaic. Request bodies are capped by `MAX_CONTENT_LENGTH`.

---

## 4. Frontend architecture (`static/script.js`)

### 4.1 The `Tile` class — the playback engine

A **tile** is one video slot on the canvas. In single-video mode there is exactly one
tile filling the canvas; in mosaic mode there are 2–6. A tile loops one or more
**scopes**; with several it is a *mixed* tile, built by dropping library entries on it.

Each tile owns **exactly two `<video>` elements, created once in the constructor and
reused for the entire life of the tile** (double buffering):

- `videos[active]` is the visible one (CSS class `front`, `opacity: 1`).
- `videos[1 - active]` is hidden and is where the *next* clip is preloaded.
- When the next clip is ready, the classes swap → CSS crossfades over 350 ms. There is
  no loading flash because the incoming element already reached `canplay`.

**Never create a `<video>` element per clip.** A previous version appended fresh
`<video>` elements to preload upcoming clips and never released them, leaking browser
memory. Element count must stay at `2 × tiles.size`, plus the one preview element of
the tile editor (empty while closed).

Key members:

| Member | Meaning |
|---|---|
| `scopes` | Array of `""` (whole library), folder paths and/or file paths. Each is passed to `/random` as a `target`; the same scope twice simply weighs double. Labels are derived from the path (`scopeLabel()`), never stored. |
| `mode` | `"clips"` = random excerpts; `"full"` = whole videos played end to end. |
| `duration` | Clip length in seconds, one of `DURATIONS` (5…60 step 5). Only meaningful in `"clips"` mode. |
| `zoom` | `"fill"` (cover), `"fit"` (contain) or `"smart"` (crop the black bars baked into the frame). See 4.6. |
| `ranges` | `{file: [from, to]}` — the cut of each file, in seconds (4.4). `rangeFor(clip)` returns the clip's cut clamped to its length, or `null`. |
| `gen` | Generation counter. See below. |
| `next` | `{clip, el}` prefetched and ready, or `null`. |
| `timer` | `setTimeout` that triggers the next clip when the current one's window ends. |

The overlay has two rows: the timeline (4.4) and the controls bar, whose title has two
parts: `.tile-scope` — the scope(s) the tile is looping, joined with `+`, hidden only
when the tile plays one single file — and `.tile-file`, the clip playing right now
(`updateTitle()`).

### 4.2 The generation counter — how rapid skipping stays consistent

Every async path (`advance`, `prepare`, `prefetch`) captures `this.gen` at entry.
`advance()` **increments** it. After every `await`, the code compares the captured value
against `this.gen` and bails out if they differ.

This is what makes hammering the skip button (or dragging tiles, or switching folders
fast) safe: in-flight loads for clips nobody wants any more resolve into a no-op instead
of racing to become visible. If you add any async work to `Tile`, it **must** follow the
same pattern.

`prepare()` also carries a 10 s watchdog (`el._failT`) and a `settled` flag so a single
promise can never resolve twice, and clears any watchdog from a previous load on the
same element.

### 4.3 Playback modes

- **`"clips"`** — `/random` returns a random file plus a random in-point; the tile seeks
  to `clip.start` and a timer fires `clipEnd()` → `advance()` after `clip.length`
  seconds. If the file has a cut, `fetchClip()` redraws the in-point inside it.
- **`"full"`** — `start`/`length` are forced to the whole file (or to its cut).
  - If the tile plays a **single file** with no cut, `el.loop = true` is set and the
    browser loops it natively: no timer, no prefetch, no network churn. This is the
    cheapest possible steady state.
  - A single file **with a cut** loops in place: `clipEnd()` seeks the same element
    back to `clip.start` (re-arming instead if a stall left the video behind). Still no
    prefetch.
  - Otherwise whole videos (or their cuts) play one after another, still double-buffered.

`armTimer()` is a no-op when `v.loop` is set — don't remove that guard or natively
looping tiles will start skipping.

### 4.4 Timeline, cuts and the tile editor

A **cut** is the part of one file a tile uses: `ranges[file] = [from, to]`. It is per
tile and per file, so it works for single files, folders and mixed tiles alike; files
without a cut are used whole. A cut covering the whole file is deleted rather than
stored, and cuts shorter than `MIN_RANGE` are refused.

`Track` is the shared timeline widget (tile overlays and the tile editor): a playhead
plus two cut handles on raw Pointer Events with pointer capture. A press within 24 px of
a handle grabs it, anywhere else scrubs (only if `seekable()`; tiles allow it in full
mode only). It owns no video: it reports `onStart` / `onPreview(t)` (moves, previewed
with `fastSeek()` — keyframe-precise, cheap) / `onSeek(t)` / `onRange(range, which)`.

- **Tile timeline** (`renderTimeline()`): always shown once a clip plays; cuts the file
  on screen. Play/pause only in full mode. Refreshed from `timeupdate`/`play`/`pause`
  **only while the overlay is visible**, so idle tiles do no DOM work.
- **`Tile.setRange(file, range, dur, which)`** stores the cut. If that file is on screen
  its window is re-cut **in place** (same element, no reload); a prefetched `next` of
  the same file is discarded and re-prefetched.
- **Tile editor** (`openEditor()`, opened from the `.tile-scope` chip, always shown):
  - scopes in the mix, each removable (`removeScope()`, never the last one);
  - the tile's volume (`setVolume()`), plus a shortcut to turn mosaic audio on;
  - every file the tile can play (`tileFiles()`, computed from the tree — no server
    call), each with a checkbox to leave it out (`toggleSkip()` → `skip`, sent to
    `/random` as repeated `skip`; the last playable file can't be left out) and its
    cut badge;
  - one big preview that loops the selected file's cut, with a `Track` to cut it.
  Its single `<video>` lives in the page and is emptied (`removeAttribute("src")` +
  `load()`) on close.
- After a scope/skip change, `rescoped()` moves on if the clip on screen is no longer
  playable, otherwise `refetch()` drops the prefetched clip. `prefetch()` carries its
  own token (`pre`) so a newer prefetch cancels an older one, and `prepare()` settles
  any previous load on the same element as stale (`el._done`), so two loads never race
  on one element. `refetch()` does nothing while `advance()` is loading (`loading`).

### 4.5 Audio

A single tile always has sound. A mosaic is muted unless the user turns **mosaic
audio** on (topbar `audioBtn`, `mosaicAudio`, remembered per device in localStorage):
then every tile plays sound together, each at its own `volume` (tile editor, saved with
the mosaic). `audible()` is the single rule, applied by `updateAudio()` and in
`advance()`. Proxies carry a light AAC track (their file names end in `-a.mp4`; older
silent proxies are simply ignored), so sound never forces the tablet back to the
originals. Note that iOS Safari ignores `video.volume`. Unmuted autoplay requires a user gesture, which is why the start screen exists —
the first tap both starts playback and satisfies the browser's autoplay policy.

### 4.6 Zoom modes and smart crop

The zoom button cycles a tile through `ZOOMS`: **fill** (`object-fit: cover`, the old
behaviour), **fit** (`contain`, black bars kept) and **smart**.

Smart exists because many "horizontal" files actually contain a vertical clip with black
bars *baked into the frame*, which `cover` cannot remove. `detectCrop()` draws one frame
of the playing element into a 64 px-wide offscreen canvas, reads it back and takes the
bounding box of everything brighter than near-black. Same-origin video, so the canvas is
never tainted; the cost is a few ms and the result is cached per file in `cropCache`.

`applyZoom()` turns that box into `object-fit: contain` plus a `translate(...) scale(k)`
that blows the content box up until it covers the tile — pure CSS, no re-encoding.
A frame that is (nearly) all black tells us nothing, so `detectCrop()` returns `null`
without caching and `refreshCrop()` retries a few times. Detection can be fooled by a
genuinely dark shot; that is acceptable because the button cycles — one more tap and the
tile is back to fill/fit. Because the transform depends on the tile's pixel size, it must
be recomputed on resize (`reZoom()`, the end of a resize gesture and `applyLayout()`).

### 4.7 Grid & layout presets

GridStack is configured as a **12 × 12 grid** (`column: 12`, `maxRow: GRID_ROWS = 12`)
whose `cellHeight` is `canvasHeight / 12`, recomputed on window resize.

**`float: true` — the grid does not gravitate.** A tile stays exactly where it is
dropped, including with empty space above it, and removing a tile leaves its hole. Do not
turn this back on and do not re-add an `applyLayout()` call to `removeTile()`.

`placeNew()` decides where a new tile goes, and its whole job is to *not disturb the
mosaic the user built*:

1. `freeRect()` — the biggest free rectangle (an occupancy map of the 12 × 12 grid,
   brute-forced; roughly square wins ties). Even a tiny hole is used: a small tile the
   user can resize beats moving everything.
2. Only if the canvas is **completely** covered, halve the biggest existing tile along
   its longer side and take that half. Exactly one tile changes size, none ever moves.
3. If not even that is possible, refuse with a toast.

`PRESETS` maps a preset id to `{label, icon, fits(n), gen(n)}` (plus `random: true` for
generators that roll a different result every call), where `gen(n)` returns `n`
rectangles as `[x, y, w, h]`:

| Preset | Behaviour |
|---|---|
| `auto` | Hand-tuned per tile count (`AUTO_LAYOUTS`), 1–6 tiles. The default and the fallback. |
| `smart` | `randomSplit(n)`: recursively cuts the canvas in two, choosing the direction from the rectangle's **on-screen** aspect (so tiles never get thin on this particular display) and the ratio at random from `ratios`. Usually cuts the biggest rectangle, sometimes not — that is what produces a mix of big and small tiles. Tap it again for another arrangement; the popover deliberately stays open for `random` presets. |
| `hero` | One 8-wide protagonist plus the others stacked in the remaining column. |
| `cols` / `rows` | `n` even vertical / horizontal strips (`splitEven` distributes the remainder so widths always sum to 12). |
| `grid22` | 2×2 quadrants, 2–4 tiles. |
| `grid32` | 3×2 cells, 2–6 tiles. |

`currentPreset` is global and sticky, but it is now applied **only** when the user picks
it from the popover (or through `randomMosaic`/`loadMosaic`) — never as a side effect of
adding or removing a tile. `layoutFor(n)` falls back to `auto` when the active preset
doesn't fit the tile count, or when a generator returned fewer rectangles than tiles.

**Moving and resizing are ours, not GridStack's** (`disableDrag` + `disableResize`):
GridStack pushes neighbours away, or refuses on a full grid. GridStack only lays tiles
out; nothing may let two items overlap, or its engine pushes one away.

- **Resize** (`makeResizable()`): four corner handles (`.tile-resize`, on the grid item
  so they survive tile rebuilds, shown while the overlay is). Each moving edge acts as
  a splitter. Growing: `fitResize()` shrinks every neighbour the tile eats into, on the
  side facing it (a diagonal neighbour gives up the cheaper side), never below
  `MIN_CELLS` — the tile stops instead. Shrinking: `fillGaps()` lets the neighbours that
  touched that edge grow into the freed strip, when nothing else is in the way.
  Everything is computed from the geometry captured at `pointerdown`, so going back and
  forth in one gesture is lossless. `applyRects()` applies a new layout in two steps
  (every item first shrinks to what its old and new rects share, then grows), so items
  never overlap mid-way.
- **Move** (`makeMovable()`): dragging a tile beyond `DRAG_SLOP` runs the same drag
  session as a library entry (4.9), with the tile itself left out of the planning (its
  own area counts as free): onto another tile's middle it **mixes** the two
  (`Tile.mergeFrom()`, the dragged tile goes away), anywhere else it moves there.

`addTile(scopes, opts)` accepts `opts.rect` to place a tile at an exact position
(used by saved mosaics, random mosaics and `playScope`), bypassing `placeNew()`.

### 4.8 Saved mosaics

Stored on the server (`/mosaics`, one JSON file each) as
`{id, name, preset, created, tiles: [{scopes, mode, duration, zoom, ranges, x, y, w, h}]}`
and shared by every client. The client keeps the last fetched list in `mosaics` and
re-fetches it whenever the sidebar opens — that is the whole "sync" story; concurrent
edits are last-write-wins. Tiles saved before mixed scopes existed carry a single `scope`
(and a now-ignored `label`); `loadMosaic()` still reads them.

Older versions kept mosaics in `localStorage` (`kiosk.mosaics`). `migrateLocal()` runs at
startup: it fixes ids, uploads every entry, and deletes the local key only when all of
them succeeded, so a failed migration retries on the next start without duplicating.

`snapshotTiles()` reads geometry through `itemRect()` (GridStack's `gridstackNode`, with
the `gs-*` attributes as fallback) so manual drags and resizes are captured;
`loadMosaic()` restores each tile with an explicit `rect`. A saved mosaic can be
**updated in place** (`updateMosaic()`, the save icon on its row) or renamed, so tweaking
one never means re-creating it.

`randomMosaic(scope)` picks 2–6 tiles and a random preset that fits, all tiles
sharing the same scope in `"clips"` mode. It is reachable from the mosaic button on
every folder row (and on the library root row).

### 4.9 Interaction model (the app's whole UX)

This is deliberately the entire feature set (plus the regia, 4.12). Do not add modes.

- **Drawer** → two tabs: **Libreria** and **Mosaici** (saved mosaics, 4.8).
- **Library** → one folder at a time (`navPath`) as a grid of cards with a preview
  frame (`/thumb`, `loading="lazy"`; a folder shows its first video and a file count).
  Breadcrumbs on top; the bar's buttons play / random-mosaic the open folder.
  **Tap** a folder card → opens it; its ▶ button plays it; **tap** a video card →
  clears the canvas and plays it as one full-canvas tile.
- **Long-press (350 ms) + drag** a library card onto the canvas. While dragging, the
  landing spot is previewed live (`dragSession()` → `planDrop()` / `setPlan()`):
  - **empty space** → a new tile on the biggest free rectangle under the finger
    (`freeRectAt()`), shown as `#drop-slot`;
  - **outer band of a tile** (`EDGE`) → that tile is really, temporarily shrunk to
    half on the opposite side and the new tile takes the half under the finger;
  - **middle of a tile**, or any tile once `MAX_TILES = 6` is reached → mix into it
    (`Tile.addScope()`), with a «Mescola» veil.
  Releasing commits; leaving the canvas or cancelling restores the shrunk tile.
- **Long-press + drag** an entry that is already in the mosaic is fine: duplicates are
  never refused.
- **Drag a tile** onto another → mix them; elsewhere → move it (same preview rules).
- **Corners of a tile** (visible with its overlay) → resize (4.7).
- **Tap a tile** → shows its overlay for 3.5 s: scope chip (→ tile editor, 4.4) +
  filename, timeline, clip-duration pill, zoom cycle, mode toggle (shuffle ↔ repeat),
  duplicate, skip, close.
- **Duplicate** (`duplicateTile()`) → a copy with the same scopes, settings and cuts;
  free space first, otherwise `placeNew(prefer)` splits the duplicated tile itself.
- **Topbar** → library drawer, undo, layout presets, pause, skip-all, mosaic audio,
  fullscreen. Auto-hides
  after 3.5 s of no pointer activity (kept visible while the drawer is open).

The drag is implemented with **raw Pointer Events**, not HTML5 drag & drop (which is
unreliable on touch). Mechanics worth knowing before touching `makeDraggable()` /
`makeMovable()` / `dragSession()`:

- A `setTimeout(PRESS_MS)` arms the drag; pointer movement beyond `DRAG_SLOP` (12 px)
  before it fires cancels it, so scrolling the library never turns into a drag. Tiles
  need no long press: moving beyond `DRAG_SLOP` starts the drag, less is a tap.
- `card._dragged` / `item._dragged` swallow the `click` that the browser emits after the drag, so
  dropping a row doesn't also trigger "play this scope". It is cleared 300 ms later.
- Plans are computed against `base`, the geometry captured when the drag armed —
  never against the live DOM, which the preview itself is changing (that would make
  the plan flicker). Only one preview is applied at a time; `setPlan()` undoes the
  previous one first. Dropping back over the open sidebar does nothing.
- `touchmove` is `preventDefault`ed **only while dragging**, so the library still scrolls.

### 4.10 Undo

`undoStack` holds up to `UNDO_MAX` entries `{label, undo}`; the topbar `undoBtn` pops
one. Two kinds:

- **Canvas edits** call `remember(label)` *before* changing anything (or pass a snapshot
  taken earlier, as `dragSession()` and `makeResizable()` do). The snapshot is
  `canvasSnap()` = preset + `snapshotTiles()`, the same shape a saved mosaic has.
  `restoreCanvas()` puts it back disturbing as little as possible: tiles are matched by
  list position, extra trailing tiles are removed, tiles with the same content are
  `retune()`d in place (zoom, volume, cuts — they keep playing), changed ones are
  rebuilt on a fresh content element, missing ones are added.
- **Saved-mosaic edits** (save, update, rename, delete) push a closure that writes the
  previous server copy back (or deletes the new one).

Anything that changes the canvas must call `remember()` first. Skip, pause and library
navigation are not undoable.

### 4.11 Controls inside tiles

Any interactive control living **inside** a tile must call `stopDrag(el)`, which stops
`pointerdown`/`mousedown`/`touchstart` propagation. Otherwise `makeMovable()` treats
the press as the start of a tile move and the button never fires. This applies to
`tileBtn()`, `tilePill()`, the duration panel, the timeline track, the scope chip and
the resize corners.

### 4.12 Regia (smart mosaic) — `static/smart.js` + `analysis.py`

A separate mode, deliberately **not** built on tiles, GridStack, undo or the drop
planner. Starting it snapshots the mosaic (`canvasSnap()`), clears it (releasing its
decoders) and shows `#smart-stage`; stopping restores the snapshot. Playing anything
else (`playScope`, `randomMosaic`, `loadMosaic`) stops it without restoring.

**No machine learning.** `analysis.py` runs one ffmpeg pass per video and reads what
ffmpeg's own filters print for each sampled frame: `scene_score` (cuts), `YDIF`
(motion), `YAVG` (brightness), `UAVG`/`VAVG` (colour), `cropdetect` (bars baked into the
frame), plus `ffprobe` for size and rotation. The result per file: real `aspect` of the
content, `crop` box, and `shots: [start, end, motion, luma, u, v]` — cut where the scene
score jumps (`SCENE_CUT`), shots shorter than `MIN_SHOT` merged.

The **director** (client) is a handful of readable rules:
- material = shots of the sources, minus black and very short ones; motion becomes a
  percentile (`energy`) so "calm" means the same in any folder;
- a **phase** (a few moves long) targets an energy and often a hue; the next phase
  contrasts with the last; `chooseShot()` scores shots on energy, colour, fit to the
  frame, not already on screen, not played lately, plus a little randomness. In a cell
  that **stands out** (`standsOut()`: ≥ `HIGHLIGHT_SHARE` of the stage or
  `HIGHLIGHT_REL`× the average cell — a lone full-screen cell always does) a clip of the
  opposite orientation is **excluded**, not just penalised (unless no other shot exists);
- clips are whole shots, or a window of a long one (`RHYTHMS[…].max`), see `clipOf()`;
- the cell count **breathes** 1 → `density` → 1 (`targetCount()`), one change per move
  (`tick()`): grow, shrink, re-plan (`settle()`), nudge a split, or refresh one cell;
- layout is a **tree of splits** (`{cell}` / `{dir, ratio, a, b}`), and it is **planned,
  not placed by a local rule**: the director builds candidate trees (`withCell()`: every
  leaf, both directions, both sides; `without()`: every cell that could leave), tunes
  every split's direction and ratio with a local search (`optimize()`), and keeps the
  cheapest (`cheapest()`). `grow()` plans both a horizontal and a vertical candidate
  shot and adds whichever leaves the better stage. All taste lives in `cost()`, one term
  per thing that looks wrong: cells wider than the stage itself or thinner than
  `minA` (no long strips on a long tablet), cells much smaller than the average or with
  a side under 20% of the stage height (no crumbs), clip/frame shape mismatch weighted
  by the cell's size, a crossed orientation in a cell that stands out, and movement of
  cells already on stage (continuity). Tune it there. With ≤ 6 cells a decision is a
  few thousand `cost()` calls — milliseconds;
- after any layout change a cell that now stands out with a crossed clip switches to a
  fitting one at once; a prefetched clip that no longer fits its cell is dropped;
- each `Cell` owns two `<video>` elements (double buffer, generation counter, `_done`
  stale-load guard, released on `destroy()`), picks its next shot for its current shape
  when its shot ends; with more than one cell it plays proxies; all at `cfg.volume`.

Sources are added by dropping library cards on the «Regia» tab or on the stage while
it runs. The tab shows sources (with `ready/total` coverage), the knobs (ritmo,
densità, volume), start/save, and the **analysis progress**: batch bar + count + ETA,
one bar per file in progress, library coverage, the speed selector, pause/resume and
"analyse the whole library". The
stage shows a small pill while its sources are still being analysed, and a waiting
screen until the first material is ready. Status is polled only while the tab is open
or the regia runs with work pending. A saved regia is a mosaic with `kind: "smart"`
and `smart: {sources, rhythm, density, volume}` — never the (always different) result.

---

## 5. Styling conventions (`static/style.css`)

Design language: **on pure black** (`--bg: #000` — the kiosk is an AMOLED tablet
in a dark photo room, and black pixels are off). Solid surfaces (`--panel`,
`--panel-2`, `--panel-3`), 1 px lines, one accent per theme, tabular numerals. The owner
explicitly asked to drop the "made by an LLM" look: **no box-shadows, no
`backdrop-filter` blur, no gradients, no glow, no uppercase letter-spaced
micro-labels, no entrance animations** — except where a theme asks for an effect on
purpose, and then only through the effect tokens (below).

**Nine themes**, one per kind of shoot the studio shows off (the kiosk is a showcase
of the studio's work before production), picked per device from the drawer header
(palette button → `#themeBar`, `applyTheme()`, `localStorage["kiosk.theme"]`, applied by
an inline script in `<head>` before the first paint). They all share the black:

| Theme | For | Look | Type | Corners |
|---|---|---|---|---|
| `camera` (default, `:root`) | the darkroom itself | safelight red, **text red too** | IBM Plex Mono | 2–4 px |
| `pellicola` | film, warm work | amber, paper text | Space Grotesk | 10–18 px |
| `ghiaccio` | anything, quietly | cyan | Inter | 6–10 px |
| `vetro` | showpiece | Apple-style liquid glass: lens surfaces, blur + saturate + brighten, specular rims, glossy white primary pill | Manrope | 16–28 px, capsules |
| `luci` | nude, the fun way | sexy-shop neon: lipstick red → hot pink, velvet blacks, glowing tubes | Space Grotesk, Bebas Neue, Mr Dafoe sign (breathing, flickering) | capsules |
| `atelier` | luxury, haute couture | black + champagne gold foil, spaced capitals | Jost, Cormorant Garamond | square |
| `galleria` | products, still life | black and white only, no colour | Archivo | square |
| `festa` | birthdays, parties | confetti gradient (pink, sun, sky), bouncing title | Fredoka | round, capsules |
| `boudoir` | artistic nude | antique rose and mauve, candlelit title | Cormorant Garamond italic | round, capsules |

**The tokens.** Colours: `--panel*`, `--line*`, `--text*`, `--accent`, `--accent-2`,
`--accent-ink`, `--accent-dim`, `--accent-soft`, `--accent-fill` (solid accent
backgrounds — may be a gradient), `--surface` (floating surfaces — may be a gradient),
`--scrim`. Type: `--font`, `--font-size`, `--font-display`, `--tab-size`, `--label-*`
(size, transform, spacing, style), `--font-title`, `--title-*` (size, weight, style,
spacing, transform, color, fill, anim). Shape: `--r-sm/md/lg`, `--r-btn` (buttons, tabs,
chips — `999px` makes capsules). Effects: `--blur` (backdrop-filter of floating
surfaces), `--sheen` (their box-shadow), `--sheen-sm` (controls), `--neon` (accented,
active things), `--glow` (accented text). Every token has a neutral default in `:root`
(shadows default to `0 0 #0000`, a shadow that draws nothing, so they can be combined in
one `box-shadow` list); a theme sets only what it changes.

**Where they apply.** Rules throughout the file read the colour/type/shape tokens. The
effects, surfaces, capsules and title/label styles are applied in **one** block, "THEME
EFFECTS", at the end of `style.css`; never put a blur, a shadow, a glow or a theme
selector anywhere else (the only `:root[data-theme=…]` rules outside the token blocks
live there too). Blur is not applied to controls *inside* a blurred surface (nested
backdrop filters see nothing). `vetro` costs GPU time on a tablet that is also decoding
video — if the mosaic stutters with it, that's why.

Never hardcode a colour, a font, a radius or an effect at a call site; a new token
needs a neutral default in `:root`. Only theme-neutral black veils (`rgba(0,0,0,…)`)
are written inline. `THEMES` in `script.js` repeats three colours per theme for the
picker's swatches only (keep it in sync when adding a theme).

Conventions to preserve:

- Touch targets are `--hit` (44 px) — this runs on a tablet, driven by fingers.
- Tile controls sit on a solid scrim band (`--scrim`) and wrap on narrow tiles.
- Dark only. There is no light theme and none is wanted.

---

## 6. Local development & debugging

The container bind-mounts the repository, so **frontend edits need only a browser
refresh** — no rebuild, no restart. Only Python changes (`app.py`, `library.py`,
`mosaics.py`, `proxy.py`) require a container restart (the reloader is off by design).

Build and run with a video directory of your choice:

```bash
docker build -t video-kiosk:dev . && docker run -d --name vk-dev -p 8080:8080 -v "$PWD:/app" -v "/path/to/videos:/app/videos" video-kiosk:dev
```

Generate throwaway test clips using the ffmpeg already inside the image (writes six
files into nested folders under `./testvideos`):

```bash
docker run --rm -v "$PWD/testvideos:/out" --entrypoint sh video-kiosk:dev -c 'mkdir -p /out/nature /out/city/day /out/city/night; for f in nature/forest nature/ocean city/day/street city/day/market city/night/neon city/night/skyline; do ffmpeg -v error -f lavfi -i "testsrc2=size=640x360:rate=24:duration=40" -f lavfi -i "sine=frequency=440:duration=40" -pix_fmt yuv420p -c:v libx264 -preset ultrafast -c:a aac -shortest -movflags +faststart "/out/$f.mp4" -y; done'
```

Useful checks:

```bash
curl -s -o /dev/null -D - -H "Range: bytes=0-1023" http://localhost:8080/video/nature/forest.mp4
```

Expect `206 PARTIAL CONTENT` with a `Content-Range` header. A `200` means Range support
regressed and every seek will download whole files.

```bash
docker stats vk-dev --no-stream --format "{{.MemUsage}}"
```

Run it before and after hammering `/random` and `/video`. The number must not grow.

In the browser, the invariant to verify after any playback change is the live element
count — it must equal twice the tile count plus one (the editor preview) and never drift
upward:

```js
document.querySelectorAll('video').length
```

---

## 7. Invariants checklist

Before considering a change to this repo done, confirm all of these still hold:

1. The server never holds video **bytes** in memory; `/video` still answers `206` to
   Range requests. Proxies are files on disk, transcoded outside the request.
2. `<video>` element count stays at `2 × tiles.size + 1` (editor preview), or
   `2 × cells + 1` while the regia runs; `Tile.destroy()` still does
   `removeAttribute("src")` + `load()` to release the decoder.
3. Every `await` inside `Tile` is followed by a generation check.
4. The grid does not gravitate (`float: true`) and adding a tile never re-lays-out the
   mosaic: `placeNew()` uses free space, or halves a single tile as a last resort.
5. Controls inside tiles still call `stopDrag()`.
6. `audible()` decides sound: one tile, or mosaic audio on. Proxies carry audio.
7. The app never writes to or deletes from the video library; the only things it writes
   are proxies, thumbnails, analyses and mosaic JSON files, and mosaic ids are validated before becoming file
   names.
8. UI strings are Italian; code and comments are English.
9. No new runtime dependencies, no build step.
10. Every canvas change goes through `remember()` first, so it can be undone.
11. The regia stays separate: it uses no `Tile`, no GridStack, no undo, and analysis
    never runs inside a request. At "low" speed it never takes more than one file and
    2 ffmpeg threads.

## 8. Working agreements

- The owner verifies changes personally on the real kiosk. When asked to only write
  code, do not run builds, tests, or containers.
- Do not commit or push unless explicitly asked.
- Prefer deleting code over adding options. This app's value is that it is small.

## 9. Publishing (GHCR)

Same mechanism as the owner's `lodge` repo. One image, `ghcr.io/jasoc/video-kiosk`, in
channels — iterating never needs a version:

| Trigger | Tags | Meaning |
|---|---|---|
| push to `main` touching the image (`*.py`, `requirements.txt`, `static/**`, `Dockerfile`, `.dockerignore`) | `sha-<short>`, `edge` | automatic, what a test kiosk follows |
| manual run on a branch (`gh workflow run docker-publish.yml --ref <branch>`) | `sha-<short>`, `br-<branch>` | try a branch |
| tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `X` (not for `v0.*`), `latest` | **a release — only this moves `latest`**, and only when the owner says so |
| tag `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` | pre-release, `latest` stays |

Nothing is pushed unless `ci.yml` passes on the same commit: Python compiles, JS parses.
(Unlike `lodge`, no Trivy scan — dropped on purpose by the owner.) Consecutive pushes cancel each other
(`concurrency`). The image carries `org.opencontainers.image.version` from
`git describe` (`1.3.0`, `1.2.0-5-gabc1234`, or a bare sha before the first tag).

Never create or push a release tag unless the owner asks for that release.
