# video-kiosk

A touch-friendly video wall for a physical space. Point it at a directory of videos and
it plays endless loops of random clips from any folder you pick — or drag videos onto
the canvas to build a mosaic of up to six players at once.

Built for a wall-mounted tablet in an atelier: no configuration screens, no accounts,
no build step. One Docker container, one folder of videos.

## Features

- **Random clip loops** — tap the library root, any folder, or a single video to loop
  random excerpts from it.
- **Two playback modes per player** — random clips (5s–60s, in 5s steps) or whole videos
  looped end to end, with a seek bar and play/pause. Configurable independently for every
  tile in a mosaic.
- **Mixed players** — drop a second folder (or video) on a player and it mixes clips from
  both.
- **Cuts** — drag the two handles on a player's timeline to use only part of the video
  on screen (loop it, or draw random clips from it). Tap the folder chip of a player to
  cut every video it can play, with a large preview.
- **Duplicate** — copy a player with all its folders, settings and cuts in one tap.
- **Mosaic mode** — long-press an item in the library and drag it onto the canvas to
  build a split view of up to 6 videos. Drag a player to move it, or onto another to mix
  them; resize it from any corner and its neighbours make room.
- **Layout presets** — auto, columns, rows, 2×2 and 3×2 grids. Layouts always fill the
  whole canvas, and re-flow automatically as you add or remove videos.
- **Random mosaics** — one tap on a folder builds a mosaic with a random number of
  players in a random layout, all looping clips from that folder.
- **Saved mosaics** — name a composition and restore it later, geometry and per-tile
  settings included. Stored on the server, so every device sees the same list.
- **Regia (smart mosaic)** — drop folders on the «Regia» tab and let it compose by
  itself: shots cut where the video cuts, cells that breathe from one to many, vertical
  clips in vertical cells, phases of calm and movement, colours that belong together. No
  machine learning: the server analyses every video once with ffmpeg (progress shown in
  the tab), and a few simple rules do the rest. Save a regia like a mosaic.
- **Smooth transitions** — every tile double-buffers two `<video>` elements and
  prefetches the next clip, so changes are instant crossfades with no loading flash.
- **Flat memory usage** — the server streams bytes with HTTP Range support and keeps no
  video cache in memory, so it stays lightweight no matter how long the kiosk runs.

## Requirements

- Docker
- A directory of videos (`.mp4`, `.mov`, `.webm`, `.avi`, `.mkv`), nested folders welcome

## Installation

Create a `.env` file next to your compose file (see `.env.example`):

```
VIDEO_DIR=/path/to/your/videos
PORT=8080
```

Then use the published image:

```yaml
services:
  video-kiosk:
    image: ghcr.io/jasoc/video-kiosk:0.0.2
    container_name: video-kiosk
    restart: unless-stopped
    ports:
      - "${PORT}:8080"
    volumes:
      - ${VIDEO_DIR}:/app/videos
      - proxies:/app/proxies
      - data:/app/data

volumes:
  proxies:   # low-res copies for mosaics, rebuilt on demand
  data:      # saved mosaics (JSON files) — keep this one
```

```bash
docker compose -f compose-ghcr.yaml up -d
```

Open `http://<host>:${PORT}` on the kiosk device and put the browser in fullscreen.

To build from source instead, use `compose.yaml`, which builds the image locally and
bind-mounts the repository for live editing.

## Usage

| Gesture | Result |
|---|---|
| Tap a folder in the library | Opens it (the library is a grid of previews) |
| Tap a video, or ▶ on a folder | Plays it full-canvas as a loop of random clips |
| Mosaic icon in the library bar | Builds a random mosaic from the open folder |
| Drag a player onto another | Mixes them into one |
| Long-press an item and drag it onto empty space or the edge of a video | Previews and adds a new player there (up to 6) |
| Long-press an item and drag it onto the middle of a video | Mixes it into that video |
| Tap a video in the mosaic | Reveals its controls: timeline, clip length, zoom, playback mode, duplicate, skip, remove |
| Drag the handles on a player's timeline | Restricts that video to the selected part |
| Tap the chip of a player | Opens its editor: remove folders from the mix, leave videos out, cut, volume |
| Undo button in the top bar | Takes back the last change (up to 25) |
| Speaker button in the top bar | Turns sound on for every player in a mosaic |
| Drag a player's corner (tap it first) | Resizes it; neighbours shrink or grow to fit |
| Layout button in the top bar | Applies a preset layout |
| `+` in the Mosaici tab | Saves the current mosaic under a name |

A single video always plays with sound. A mosaic is muted unless you turn mosaic audio
on; each player then has its own volume (in its editor).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VIDEOS_DIR` | `/app/videos` | Where the container looks for videos |
| `DATA_DIR` | `/app/data` | Where saved mosaics are written, one JSON file each |
| `PORT` | `8080` | Host port published by compose |

Saved mosaics are shared by every device. Mosaics saved by older versions in a browser's
`localStorage` are moved to the server automatically the first time that browser opens
the new version.

The app never modifies the video library: organise your files outside of it.

## Architecture

- **Backend** — Flask. Serves the folder tree, streams video files with Range support,
  returns random clip descriptors, stores saved mosaics as JSON files, builds low-res
  proxies and thumbnails, and analyses videos for the regia — all ffmpeg work runs in
  the background or is cached on disk. Caches only metadata in memory, never video
  bytes.
- **Frontend** — vanilla HTML/CSS/JS (`static/`). GridStack lays the mosaic out; moving,
  resizing and everything else is hand-rolled. The regia lives in `static/smart.js`.
- **Image** — `python:3.12-alpine` plus `ffmpeg`.

Contributors and coding agents: see [CLAUDE.md](CLAUDE.md) for the detailed design
notes, playback internals, and the invariants that must not be broken.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with
your changes. Keep in mind that this project deliberately stays small — simplifications
are more welcome than new features.

## License

This project is licensed under the [MIT License](LICENSE).
