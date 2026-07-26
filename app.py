import json
import logging
import os
import random
import subprocess
import threading
import time

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")
app.logger.setLevel(logging.INFO)

ROOT_DIR = os.environ.get("VIDEOS_DIR", "/app/videos")
VIDEO_EXT = (".mp4", ".mov", ".webm", ".avi", ".mkv")

# Only metadata is cached (paths and durations) — video bytes are streamed
# straight from disk with Range support and cached by the OS page cache.
LIST_TTL = 30.0
_list_cache = {"time": 0.0, "videos": []}
_list_lock = threading.Lock()

_dur_cache = {}
_dur_lock = threading.Lock()


def all_videos():
    """Relative paths of every video under ROOT_DIR, cached for LIST_TTL."""
    with _list_lock:
        if time.monotonic() - _list_cache["time"] < LIST_TTL:
            return _list_cache["videos"]
    videos = []
    for root, _, files in os.walk(ROOT_DIR):
        for f in files:
            if f.lower().endswith(VIDEO_EXT):
                rel = os.path.relpath(os.path.join(root, f), ROOT_DIR)
                videos.append(rel.replace(os.sep, "/"))
    with _list_lock:
        _list_cache["time"] = time.monotonic()
        _list_cache["videos"] = videos
    return videos


def get_duration(abspath):
    with _dur_lock:
        if abspath in _dur_cache:
            return _dur_cache[abspath]
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", abspath],
            stderr=subprocess.DEVNULL,
        )
        dur = float(json.loads(out)["format"]["duration"])
    except Exception as e:
        app.logger.error("ffprobe failed for %s: %s", abspath, e)
        dur = 60.0
    with _dur_lock:
        _dur_cache[abspath] = dur
    return dur


def build_tree(path):
    items = []
    try:
        entries = sorted(os.listdir(path), key=str.lower)
    except OSError:
        return items
    for name in entries:
        fp = os.path.join(path, name)
        rel = os.path.relpath(fp, ROOT_DIR).replace(os.sep, "/")
        if os.path.isdir(fp):
            children = build_tree(fp)
            if children:
                items.append({"type": "dir", "name": name, "path": rel,
                              "children": children})
        elif name.lower().endswith(VIDEO_EXT):
            items.append({"type": "file", "name": name, "path": rel})
    return items


@app.route("/")
def root():
    return send_from_directory("static", "index.html")


@app.route("/tree")
def tree():
    return jsonify(build_tree(ROOT_DIR))


@app.route("/video/<path:p>")
def video(p):
    # conditional=True enables HTTP Range responses: the client only pulls
    # the byte ranges it actually plays, and seeking is cheap.
    return send_from_directory(ROOT_DIR, p, conditional=True)


@app.route("/random")
def random_clip():
    target = request.args.get("target", "").strip("/")
    clip_len = max(1.0, float(request.args.get("duration", 20)))

    videos = all_videos()
    if not target:
        pool = videos
    elif target in videos:
        pool = [target]
    else:
        prefix = target + "/"
        pool = [v for v in videos if v.startswith(prefix)]
    if not pool:
        return jsonify({"error": "no videos"}), 404

    rel = random.choice(pool)
    dur = get_duration(os.path.join(ROOT_DIR, rel.replace("/", os.sep)))
    if dur <= clip_len:
        start, length = 0.0, dur
    else:
        start = random.uniform(0, dur - clip_len)
        length = clip_len

    return jsonify({"file": rel, "start": round(start, 2),
                    "length": round(length, 2), "dur": round(dur, 2)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, threaded=True)
