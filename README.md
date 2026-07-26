# video-kiosk

## Overview

`video-kiosk` is a lightweight and customizable application designed to display videos in a kiosk-like environment. It is ideal for exhibitions, trade shows, or any scenario where looping video playback is required.

## Features

- **Random clip loops**: tap the root, any folder, or a single video in the library tree to loop random clips from it. Per tile you can switch between random clips (5s–60s, in 5s steps) and whole looping videos.
- **Mosaic mode**: long-press a video or folder in the tree and drag it onto the canvas to build a split view (up to 6 tiles), with drag & resize handles powered by GridStack. Preset layouts (columns, rows, 2×2, 3×2) and named mosaics saved in the browser's localStorage.
- **Smooth transitions**: each tile double-buffers two `<video>` elements and prefetches the next clip, so swaps are instant crossfades.
- **Lightweight**: the server only streams bytes with HTTP Range support — no in-memory video cache, flat memory usage.

## Installation

1. docker comppose
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

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes.

## License

This project is licensed under the [MIT License](LICENSE).
