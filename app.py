from flask import Flask, jsonify, send_from_directory, request
import os
import random
import subprocess
import json
import threading

app = Flask(__name__, static_folder="static", static_url_path="")
ROOT_DIR = "/app/videos"
dur_cache = {}
dur_lock = threading.Lock()

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
    except Exception:
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
    base = os.path.join(ROOT_DIR, target)
    if os.path.isdir(base):
        vids = list_videos(base)
        if not vids:
            return jsonify({"error": "no videos"})
        vf = random.choice(vids)
    else:
        vf = base
    dur = get_duration(vf)
    clip_len = random.randint(30, 40)
    start = random.uniform(0, max(dur-clip_len, 0))
    return jsonify({
        "file": os.path.relpath(vf, ROOT_DIR),
        "start": round(start, 2),
        "length": clip_len,
        "dur": round(dur, 2)
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
