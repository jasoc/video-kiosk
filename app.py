from collections import deque
from flask import Flask, jsonify, send_from_directory, request
import logging
import os
import random
import subprocess
import json
import threading
import time

app = Flask(__name__, static_folder="static", static_url_path="")
app.logger.setLevel(logging.INFO)
ROOT_DIR = "/app/videos"
dur_cache = {}
dur_lock = threading.Lock()
rng = random.SystemRandom()
recent_lock = threading.Lock()
recent_videos = deque(maxlen=8)
stats_lock = threading.Lock()
video_stats = {}

# ------------------ Helpers ------------------


def list_videos(folder):
    videos = []
    for root, _, files in os.walk(folder):
        for f in files:
            if f.lower().endswith((".mp4", ".mov", ".webm", ".avi", ".mkv")):
                videos.append(os.path.join(root, f))
    return videos


def get_duration(path):
    abspath = os.path.abspath(path)
    with dur_lock:
        if abspath in dur_cache:
            return dur_cache[abspath]
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", abspath],
            stderr=subprocess.DEVNULL
        ).decode()
        dur = float(json.loads(out)["format"]["duration"])
    except Exception as e:
        app.logger.error("Error getting duration for %s: %s", abspath, e)
        dur = 60.0
    with dur_lock:
        dur_cache[abspath] = dur
    return dur


def build_tree(path):
    items = []
    for name in sorted(os.listdir(path)):
        fp = os.path.join(path, name)
        if os.path.isdir(fp):
            items.append({"type": "dir", "name": name,
                          "path": os.path.relpath(fp, ROOT_DIR),
                          "children": build_tree(fp)})
        elif name.lower().endswith((".mp4", ".mov", ".webm", ".avi", ".mkv")):
            items.append({"type": "file", "name": name,
                          "path": os.path.relpath(fp, ROOT_DIR)})
    return items


def register_video(path):
    with stats_lock:
        if path not in video_stats:
            video_stats[path] = {
                "plays": 0,
                "last_seen": 0.0,
                "last_start": None,
            }


def choose_video(vids, record=True):
    if not vids:
        raise ValueError("video pool is empty")
    with stats_lock:
        for v in vids:
            if v not in video_stats:
                video_stats[v] = {
                    "plays": 0,
                    "last_seen": 0.0,
                    "last_start": None,
                }
        plays_snapshot = {v: video_stats[v]["plays"] for v in vids}
    with recent_lock:
        recent_snapshot = set(recent_videos)
    candidates = [v for v in vids if v not in recent_snapshot] or vids
    min_play = min(plays_snapshot[v] for v in candidates)
    pool = [v for v in candidates if plays_snapshot[v] == min_play]
    choice = rng.choice(pool)
    if record:
        with stats_lock:
            video_stats[choice]["plays"] += 1
            video_stats[choice]["last_seen"] = time.time()
        with recent_lock:
            recent_videos.append(choice)
    return choice


def calc_clip_length(duration):
    if duration <= 0.0:
        return 0.0
    if duration <= 20.0:
        length = duration
    elif duration <= 50.0:
        length = rng.uniform(duration * 0.55, duration * 0.85)
    elif duration <= 150.0:
        length = rng.uniform(0.25 * duration, min(0.5 * duration, 45.0))
    elif duration <= 420.0:
        length = rng.uniform(22.0, min(0.3 * duration, 75.0))
    else:
        length = rng.uniform(28.0, min(0.25 * duration, 95.0))
    floor = min(duration, 8.0)
    return max(min(length, duration), floor)


def pick_clip_window(video_path, duration, record=True):
    length = min(calc_clip_length(duration), duration)
    start_max = max(duration - length, 0.0)
    register_video(video_path)
    with stats_lock:
        last_start = video_stats[video_path]["last_start"]
    if start_max <= 0.0:
        start = 0.0
    else:
        separation = max(length * 0.5, min(duration * 0.15, 30.0), 6.0)
        start = 0.0
        for _ in range(6):
            candidate = rng.uniform(0.0, start_max)
            if last_start is None or abs(candidate - last_start) >= separation:
                start = candidate
                break
            start = candidate
    if record:
        with stats_lock:
            video_stats[video_path]["last_start"] = start
    return start, length
# ------------------ Routes ------------------
@app.route("/")
def root(): return send_from_directory("static", "index.html")


@app.route("/static/<path:p>")
def static_files(p): return send_from_directory("static", p)


@app.route("/tree")
def tree(): return jsonify(build_tree(ROOT_DIR))


@app.route("/video/<path:p>")
def video(p): return send_from_directory(ROOT_DIR, p)


@app.route("/random")
def random_clip():
    target = request.args.get("target", "")
    preview = request.args.get("preview", "").lower() in {"1", "true", "yes"}
    record = not preview
    base = os.path.join(ROOT_DIR, target)
    if os.path.isdir(base):
        vids = list_videos(base)
        if not vids:
            app.logger.info(
                "random target=%s pool=0 preview=%s",
                target or "root",
                preview,
            )
            return jsonify({"error": "no videos"})
        app.logger.info(
            "random target=%s pool=%d preview=%s",
            target or "root",
            len(vids),
            preview,
        )
        vf = choose_video(vids, record=record)
    else:
        vf = base
        if not os.path.isfile(vf):
            return jsonify({"error": "video not found"}), 404
        register_video(vf)
        if record:
            with stats_lock:
                video_stats[vf]["plays"] += 1
                video_stats[vf]["last_seen"] = time.time()
    dur = get_duration(vf)
    start, clip_len = pick_clip_window(vf, dur, record=record)
    clip_len = min(clip_len, dur)
    app.logger.info(
        "random choice file=%s start=%.2f len=%.2f dur=%.2f preview=%s",
        os.path.relpath(vf, ROOT_DIR),
        start,
        clip_len,
        dur,
        preview,
    )
    return jsonify({
        "file": os.path.relpath(vf, ROOT_DIR),
        "start": round(start, 2),
        "length": round(clip_len, 2),
        "dur": round(dur, 2)
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
