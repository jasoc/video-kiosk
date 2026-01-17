from flask import Flask, jsonify, send_from_directory, request, Response
import logging
import os
import subprocess
import json
import threading
import time
import random

app = Flask(__name__, static_folder="static", static_url_path="")
app.logger.setLevel(logging.INFO)
ROOT_DIR = "/app/videos"

# Duration cache
dur_cache = {}
dur_lock = threading.Lock()

# Video cache for preloading
video_cache = {}
cache_lock = threading.Lock()
currently_caching = None

# Session tracking
sessions = set()
sessions_lock = threading.Lock()
cache_thread = None
cache_running = False


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
    try:
        entries = sorted(os.listdir(path))
    except Exception:
        return items
    for name in entries:
        fp = os.path.join(path, name)
        if os.path.isdir(fp):
            items.append({"type": "dir", "name": name,
                          "path": os.path.relpath(fp, ROOT_DIR),
                          "children": build_tree(fp)})
        elif name.lower().endswith((".mp4", ".mov", ".webm", ".avi", ".mkv")):
            items.append({"type": "file", "name": name,
                          "path": os.path.relpath(fp, ROOT_DIR)})
    return items


def preload_videos():
    """Preload all videos into memory cache."""
    global cache_running, currently_caching
    videos = list_videos(ROOT_DIR)
    app.logger.info("Starting preload of %d videos", len(videos))
    
    for vf in videos:
        with sessions_lock:
            if not sessions:
                app.logger.info("No sessions, stopping preload")
                cache_running = False
                currently_caching = None
                return
        
        rel_path = os.path.relpath(vf, ROOT_DIR)
        with cache_lock:
            if rel_path in video_cache:
                continue
        
        currently_caching = rel_path
        try:
            with open(vf, 'rb') as f:
                data = f.read()
            with cache_lock:
                video_cache[rel_path] = data
            app.logger.info("Cached: %s (%.1f MB)", rel_path, len(data) / 1024 / 1024)
        except Exception as e:
            app.logger.error("Failed to cache %s: %s", rel_path, e)
    
    currently_caching = None
    cache_running = False
    app.logger.info("Preload complete. Cached %d videos", len(video_cache))


def start_caching():
    """Start caching thread if not running."""
    global cache_thread, cache_running
    if cache_running:
        return
    cache_running = True
    cache_thread = threading.Thread(target=preload_videos, daemon=True)
    cache_thread.start()


def clear_cache():
    """Clear video cache when no sessions."""
    global video_cache
    with cache_lock:
        video_cache.clear()
    app.logger.info("Video cache cleared")


def get_cache_status():
    """Get cache status for loading bar."""
    videos = list_videos(ROOT_DIR)
    total = len(videos)
    with cache_lock:
        cached = len(video_cache)
        cached_list = list(video_cache.keys())
    return {
        "cached": cached,
        "total": total,
        "caching": currently_caching,
        "videos": cached_list
    }


# ------------------ Routes ------------------

@app.route("/")
def root():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory("static", p)


@app.route("/tree")
def tree():
    return jsonify(build_tree(ROOT_DIR))


@app.route("/video/<path:p>")
def video(p):
    with cache_lock:
        if p in video_cache:
            return Response(video_cache[p], mimetype='video/mp4')
    return send_from_directory(ROOT_DIR, p)


@app.route("/session/start", methods=["POST"])
def session_start():
    """Register a session and start caching."""
    session_id = request.json.get("id", str(time.time()))
    with sessions_lock:
        sessions.add(session_id)
        count = len(sessions)
    app.logger.info("Session started: %s (total: %d)", session_id, count)
    start_caching()
    return jsonify({"ok": True, "id": session_id})


@app.route("/session/end", methods=["POST"])
def session_end():
    """Unregister a session and clear cache if no sessions."""
    session_id = request.json.get("id", "")
    with sessions_lock:
        sessions.discard(session_id)
        count = len(sessions)
    app.logger.info("Session ended: %s (total: %d)", session_id, count)
    if count == 0:
        clear_cache()
    return jsonify({"ok": True})


@app.route("/cache/status")
def cache_status():
    """Return cache loading status."""
    return jsonify(get_cache_status())


@app.route("/random")
def random_clip():
    target = request.args.get("target", "")
    clip_duration = float(request.args.get("duration", 20))
    
    base = os.path.join(ROOT_DIR, target)
    if os.path.isdir(base):
        vids = list_videos(base)
        if not vids:
            return jsonify({"error": "no videos"})
        vf = random.choice(vids)
    else:
        vf = base
        if not os.path.isfile(vf):
            return jsonify({"error": "video not found"}), 404
    
    dur = get_duration(vf)
    rel_path = os.path.relpath(vf, ROOT_DIR)
    
    # Calculate start position
    if dur <= clip_duration:
        start = 0
        length = dur
    else:
        start = random.uniform(0, dur - clip_duration)
        length = clip_duration
    
    with cache_lock:
        is_cached = rel_path in video_cache
    
    app.logger.info(
        "random file=%s start=%.2f len=%.2f dur=%.2f cached=%s",
        rel_path, start, length, dur, is_cached
    )
    
    return jsonify({
        "file": rel_path,
        "start": round(start, 2),
        "length": round(length, 2),
        "dur": round(dur, 2),
        "cached": is_cached
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
