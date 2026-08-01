# CLAUDE.md

Guidance for Claude Code (and any other LLM/agent) working in this repository.

---

## 1. What this project is

`video-kiosk` is a **single-page video wall** that runs on a wall-mounted tablet in a
physical atelier. Visitors touch a folder tree and the app plays an endless loop of
random clips from that folder, or lets them drag videos onto the canvas to build a
mosaic (split view) of several videos playing at once.

It is a **toy for a physical space**, not a product. There is no auth, no multi-user
state, no database, no build step, no test suite, and no telemetry. It is deployed as
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
- **Vanilla first.** The only third-party frontend library is GridStack (mosaic drag &
  resize). Google Fonts + Material Icons come from a CDN.

---

## 2. File map

| File | Role |
|---|---|
| `app.py` | Flask routes only (~110 lines): static files, tree, video bytes, random clip descriptors, file manager. |
| `library.py` | Library scan (`all_videos`, `build_tree`) and `ffprobe` metadata (`probe`). Owns the two metadata caches. |
| `fsops.py` | File manager primitives: new folder, rename, move. Path safety lives here. No deletion, by design. |
| `proxy.py` | Background ffmpeg transcoder producing low-res proxies for mosaics. One worker thread, output on disk. |
| `static/index.html` | Full DOM skeleton. All UI elements exist up-front; JS only fills the tree, the mosaic list, and the grid. |
| `static/script.js` | All client logic: `Tile` playback engine, GridStack management, layout presets, saved mosaics, drag interaction. |
| `static/style.css` | All styling. Dark, hairline-bordered, "enterprise minimal". |
| `Dockerfile` | `python:3.12-alpine` + `ffmpeg` (needed for `ffprobe`). |
| `compose.yaml` | Local dev: builds the image, bind-mounts the repo for live editing. |
| `compose-ghcr.yaml` | Production: pulls the published `ghcr.io/jasoc/video-kiosk` image. |

**UI copy is in Italian. Code, comments, and documentation are in English.** Keep this
split — user-visible strings in `index.html` and in `script.js` (button titles, toasts,
preset labels) must stay Italian.

---

## 3. Backend (`app.py` + `library.py` + `fsops.py` + `proxy.py`)

### Endpoints

| Route | Returns |
|---|---|
| `GET /` | `static/index.html` |
| `GET /tree` | Nested JSON of the library: `{type: "dir"\|"file", name, path, children?}`. Empty directories **are** listed (you must be able to drop files into a folder you just created); dot-directories are skipped. Paths are relative to `ROOT_DIR` and always use `/` separators. |
| `GET /video/<path>[?q=low]` | The video file, **streamed with HTTP Range support** (`conditional=True` → `206 Partial Content`). With `q=low`, a ready proxy if one exists, otherwise the original (and a proxy is queued). |
| `GET /random?target=<path>&duration=<sec>` | `{file, start, length, dur}` — a randomly chosen video within `target` plus a random in-point. `target` may be `""` (whole library), a folder path, or an exact file path. `404` if the pick vanished from disk, which makes the client refresh its tree. |
| `POST /fs/folder` `{parent, name}` | Creates a folder. |
| `POST /fs/rename` `{path, name}` | Renames a file or folder (a video keeps its extension). |
| `POST /fs/move` `{src, dest}` | Moves a file or folder into the folder `dest` (`""` = library root). |

The `/fs/*` routes answer `{ok: true, path}` or `{error}` with `400`; the error string is
user-visible, hence Italian. **There is no delete route and there must not be one** — the
kiosk may reorganise the library, never destroy it.

### Configuration

`VIDEOS_DIR` env var, default `/app/videos`. In Docker the host video directory is
bind-mounted there. `PROXY_DIR`, default `/app/proxies`, holds the transcoded proxies and
is a throwaway volume.

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
  `LIST_TTL` (30 s), and invalidated immediately by `library.invalidate()` after any
  file manager operation. This exists so `/random` does not `os.walk` the tree on every
  call.
- `_meta_cache` — `{(abspath, mtime): {dur, width, height}}` populated by `ffprobe`.
  `ffprobe` is slow (subprocess spawn), so this must stay.

The same rule governs `proxy.py`: proxies are **files on disk**, produced by one
background worker thread and served with `send_from_directory(..., conditional=True)`.
Never buffer a transcode in memory, and never transcode inside a request.

Both are guarded by `threading.Lock` because Flask runs with `threaded=True`.

### Path safety

`/random` resolves `target` **against the cached video list** (exact match or `path/`
prefix), never by joining user input onto the filesystem. `/video` relies on
`send_from_directory`, which rejects traversal outside the served root. Keep both
properties if you touch these routes.

`fsops` is the only module that writes to the library. Every client-supplied path goes
through `_resolve()` (`realpath` + "must be inside `ROOT_DIR`") and every client-supplied
name through `_safe_name()` (no separators, no leading dot). Never bypass them.

---

## 4. Frontend architecture (`static/script.js`)

### 4.1 The `Tile` class — the playback engine

A **tile** is one video slot on the canvas. In single-video mode there is exactly one
tile filling the canvas; in mosaic mode there are 2–6.

Each tile owns **exactly two `<video>` elements, created once in the constructor and
reused for the entire life of the tile** (double buffering):

- `videos[active]` is the visible one (CSS class `front`, `opacity: 1`).
- `videos[1 - active]` is hidden and is where the *next* clip is preloaded.
- When the next clip is ready, the classes swap → CSS crossfades over 350 ms. There is
  no loading flash because the incoming element already reached `canplay`.

**Never create a `<video>` element per clip.** A previous version appended fresh
`<video>` elements to preload upcoming clips and never released them, leaking browser
memory. Element count must stay at `2 × tiles.size`.

Key members:

| Member | Meaning |
|---|---|
| `scope` | `""` (whole library), a folder path, or a single file path. Passed to `/random` as `target`. |
| `mode` | `"clips"` = random excerpts; `"full"` = whole videos played end to end. |
| `duration` | Clip length in seconds, one of `DURATIONS` (5…60 step 5). Only meaningful in `"clips"` mode. |
| `zoom` | `"fill"` (cover), `"fit"` (contain) or `"smart"` (crop the black bars baked into the frame). See 4.5. |
| `gen` | Generation counter. See below. |
| `next` | `{clip, el}` prefetched and ready, or `null`. |
| `timer` | `setTimeout` that triggers the next clip when the current one's window ends. |

The bottom overlay title has two parts: `.tile-scope` — the folder the tile is looping,
hidden only when the scope is one single file — and `.tile-file`, the clip playing right
now (`updateTitle()`).

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
  to `clip.start` and a timer fires `advance()` after `clip.length` seconds.
- **`"full"`** — `start` is forced to `0` and `length` to the full duration.
  - If the tile's scope is a **single file**, `el.loop = true` is set and the browser
    loops it natively: no timer, no prefetch, no network churn. This is the cheapest
    possible steady state.
  - If the scope is a folder, whole videos play one after another, still double-buffered.

`armTimer()` is a no-op when `v.loop` is set — don't remove that guard or natively
looping tiles will start skipping.

### 4.4 Audio

Audio plays only when there is exactly one tile (`updateAudio()` / the `el.muted`
assignment in `advance()`). Six simultaneous audio tracks would be noise in a physical
room. Unmuted autoplay requires a user gesture, which is why the start screen exists —
the first tap both starts playback and satisfies the browser's autoplay policy.

### 4.5 Zoom modes and smart crop

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
be recomputed on resize (`reZoom()`, the `resizestop` handler and `applyLayout()`).

### 4.6 Grid & layout presets

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

`addTile(scope, label, opts)` accepts `opts.rect` to place a tile at an exact position
(used by saved mosaics, random mosaics and `playScope`), bypassing `placeNew()`.

### 4.7 Saved mosaics

Stored in `localStorage` under `kiosk.mosaics` as an array of
`{id, name, preset, tiles: [{scope, label, mode, duration, zoom, x, y, w, h}]}`.
Entries saved before `id` existed get one assigned on first render.

`snapshotTiles()` reads geometry through `itemRect()` (GridStack's `gridstackNode`, with
the `gs-*` attributes as fallback) so manual drags and resizes are captured;
`loadMosaic()` restores each tile with an explicit `rect`. A saved mosaic can be
**updated in place** (`updateMosaic()`, the save icon on its row) or renamed, so tweaking
one never means re-creating it. Storage is per-browser/per-device — acceptable for a
single kiosk. If mosaics ever need to be shared across devices, that is a server-side
change (a JSON file next to the videos), not a localStorage change.

`randomMosaic(scope, label)` picks 2–6 tiles and a random preset that fits, all tiles
sharing the same scope in `"clips"` mode. It is reachable from the mosaic button on
every folder row (and on the library root row).

### 4.8 Interaction model (the app's whole UX)

This is deliberately the entire feature set. Do not add modes.

- **Tap** a tree row (root / folder / file) → clears the canvas, plays that scope as one
  full-canvas tile.
- **Mosaic button** on a folder row → random mosaic from that folder.
- **Long-press (350 ms) + drag** a tree row onto the canvas → adds it as a tile,
  building a mosaic incrementally. Max `MAX_TILES = 6`, enforced with a toast.
- **Long-press + drag onto a folder row** → moves that file or folder there (4.9).
- **Tap a tile** → shows its overlay for 3 s: folder + filename, clip-duration pill,
  zoom cycle, mode toggle (shuffle ↔ repeat), skip, close.
- **Topbar** → library drawer, layout presets, pause, skip-all, fullscreen. Auto-hides
  after 3.5 s of no pointer activity (kept visible while the drawer is open).

The drag is implemented with **raw Pointer Events**, not HTML5 drag & drop (which is
unreliable on touch). Mechanics worth knowing before touching `makeDraggable()`:

- A `setTimeout(PRESS_MS)` arms the drag; pointer movement beyond `DRAG_SLOP` (12 px)
  before it fires cancels it, so scrolling the tree never turns into a drag.
- `row._dragged` swallows the `click` that the browser emits after the drag, so
  dropping a row doesn't also trigger "play this scope". It is cleared 300 ms later.
- Dropping over the open sidebar never adds a tile: it either **moves** the dragged entry
  into the folder row under the pointer (`folderRowAt()` + `canMove()`, highlighted with
  `.drop-target`) or does nothing.
- `touchmove` is `preventDefault`ed **only while dragging**, so the tree still scrolls.

### 4.9 File manager

The sidebar doubles as a small file manager over `/fs/*`. It can create folders, rename
and move — **never delete**, and there is no client-side path juggling: the server is the
only thing that touches the filesystem.

- The `manageBtn` toggle (`manageMode`) swaps the per-row mosaic button for
  "new folder" / "rename". Drag-to-move works in both modes.
- `openDirs` remembers which folders are expanded, because the tree is re-fetched after
  every operation (`fsCall()` always ends with `loadTree()`).
- Conflicts between clients are not prevented, they are *survived*: `/random` returns
  `404` when its pick has vanished, `Tile.advance()` counts failures and calls
  `libraryTrouble()`, which toasts once every 15 s and reloads the tree while playback
  retries on its own. Don't grow this into locking or a sync protocol.

### 4.10 GridStack event conflicts

Any interactive control living **inside** a tile must call `stopDrag(el)`, which stops
`pointerdown`/`mousedown`/`touchstart` propagation. Otherwise GridStack interprets the
press as the start of a tile drag and the button never fires. This applies to
`tileBtn()`, `tilePill()`, the duration panel, and the caret buttons in the tree.

---

## 5. Styling conventions (`static/style.css`)

Design language: near-black background, **1 px hairline borders** rather than heavy
shadows or large radii, a single restrained accent (`--accent: #8ea8ff`), uppercase
micro-labels for section headers, tabular numerals. Everything is driven by CSS custom
properties in `:root` — change the palette there, not at call sites.

Conventions to preserve:

- Radii come from `--r-sm/md/lg`; do not hardcode `border-radius`.
- Touch targets are ≥ 34 px — this runs on a tablet, driven by fingers.
- Overlays/panels use `backdrop-filter` blur plus a hairline border, never a solid slab.
- Dark theme only. There is no light mode and none is wanted.

---

## 6. Local development & debugging

The container bind-mounts the repository, so **frontend edits need only a browser
refresh** — no rebuild, no restart. Only Python changes (`app.py`, `library.py`,
`fsops.py`, `proxy.py`) require a container restart (the reloader is off by design).

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
count — it must equal twice the tile count and never drift upward:

```js
document.querySelectorAll('video').length
```

---

## 7. Invariants checklist

Before considering a change to this repo done, confirm all of these still hold:

1. The server never holds video **bytes** in memory; `/video` still answers `206` to
   Range requests. Proxies are files on disk, transcoded outside the request.
2. `<video>` element count stays at `2 × tiles.size`; `Tile.destroy()` still does
   `removeAttribute("src")` + `load()` to release the decoder.
3. Every `await` inside `Tile` is followed by a generation check.
4. The grid does not gravitate (`float: true`) and adding a tile never re-lays-out the
   mosaic: `placeNew()` uses free space, or halves a single tile as a last resort.
5. Controls inside tiles still call `stopDrag()`.
6. Audio is unmuted only when exactly one tile exists (and a single tile always plays the
   original file, never the silent proxy).
7. Every client path reaching the filesystem goes through `fsops._resolve()` /
   `_safe_name()`, and no route deletes anything.
8. UI strings are Italian; code and comments are English.
9. No new runtime dependencies, no build step.

## 8. Working agreements

- The owner verifies changes personally on the real kiosk. When asked to only write
  code, do not run builds, tests, or containers.
- Do not commit or push unless explicitly asked.
- Prefer deleting code over adding options. This app's value is that it is small.
