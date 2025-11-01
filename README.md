# video-kiosk

## Overview

`video-kiosk` is a lightweight and customizable application designed to display videos in a kiosk-like environment. It is ideal for exhibitions, trade shows, or any scenario where looping video playback is required.

## Features

- **Simple Setup**: Easy to configure and deploy.
- **Customizable**: Supports various video formats and playback options.
- **Lightweight**: Minimal resource usage for smooth performance.
- **Looping Playback**: Automatically restarts videos for continuous display.

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
