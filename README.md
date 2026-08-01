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
  looped end to end. Configurable independently for every tile in a mosaic.
- **Mosaic mode** — long-press an item in the library and drag it onto the canvas to
  build a split view of up to 6 videos, freely draggable and resizable (GridStack).
- **Layout presets** — auto, columns, rows, 2×2 and 3×2 grids. Layouts always fill the
  whole canvas, and re-flow automatically as you add or remove videos.
- **Random mosaics** — one tap on a folder builds a mosaic with a random number of
  players in a random layout, all looping clips from that folder.
- **Saved mosaics** — name a composition and restore it later, geometry and per-tile
  modes included.
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
| Tap a folder or video in the library | Plays it full-canvas as a loop of random clips |
| Tap the mosaic icon on a folder row | Builds a random mosaic from that folder |
| Long-press an item and drag it onto the canvas | Adds it to the mosaic (up to 6) |
| Tap a video in the mosaic | Reveals its controls: clip length, playback mode, skip, remove |
| Drag a tile's corner handle | Resizes it freely |
| Layout button in the top bar | Applies a preset layout |
| `+` next to "Mosaici salvati" | Saves the current mosaic under a name |

Audio plays only when a single video fills the canvas; mosaic tiles are muted.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VIDEOS_DIR` | `/app/videos` | Where the container looks for videos |
| `PORT` | `8080` | Host port published by compose |

Saved mosaics live in the browser's `localStorage`, so they belong to the device you
created them on.

## Architecture

- **Backend** — Flask (`app.py`, ~130 lines). Serves the folder tree, streams video
  files with Range support, and returns random clip descriptors. Caches only metadata
  (file list and `ffprobe` durations), never video bytes.
- **Frontend** — vanilla HTML/CSS/JS (`static/`). GridStack handles mosaic drag and
  resize; everything else is hand-rolled.
- **Image** — `python:3.12-alpine` plus `ffmpeg` (for `ffprobe` duration probing).

Contributors and coding agents: see [CLAUDE.md](CLAUDE.md) for the detailed design
notes, playback internals, and the invariants that must not be broken.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with
your changes. Keep in mind that this project deliberately stays small — simplifications
are more welcome than new features.

## License

This project is licensed under the [MIT License](LICENSE).
