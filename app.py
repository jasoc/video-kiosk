VIDEO_DIR = "/vault/private/Ἀφροδίτη/vids"

from flask import Flask, send_from_directory, jsonify, request
import os, random, subprocess, json

app = Flask(__name__, static_folder="static", static_url_path="")

def get_duration(path):
    try:
        cmd = ["ffprobe", "-v", "error",
               "-show_entries", "format=duration",
               "-of", "json", path]
        out = subprocess.check_output(cmd)
        data = json.loads(out)
        return float(data['format']['duration'])
    except Exception:
        return 60.0

def list_dir(base):
    """Ritorna la struttura di directory e file ricorsiva (video + cartelle)."""
    tree = []
    for entry in sorted(os.listdir(base)):
        path = os.path.join(base, entry)
        relpath = os.path.relpath(path, VIDEO_DIR)
        if os.path.isdir(path):
            tree.append({
                "type": "dir",
                "name": entry,
                "path": relpath,
                "children": list_dir(path)
            })
        elif entry.lower().endswith((".mp4", ".mov", ".avi", ".mkv")):
            tree.append({
                "type": "file",
                "name": entry,
                "path": relpath
            })
    return tree

@app.route("/tree")
def tree():
    return jsonify(list_dir(VIDEO_DIR))

@app.route("/random")
def random_video():
    target = request.args.get("target")  # cartella o file relativo
    video_list = []

    # Se è una cartella → prendi tutti i video ricorsivamente
    if target:
        full_path = os.path.join(VIDEO_DIR, target)
        if os.path.isdir(full_path):
            for root, _, files in os.walk(full_path):
                for f in files:
                    if f.lower().endswith((".mp4", ".mov", ".avi", ".mkv")):
                        video_list.append(os.path.relpath(os.path.join(root, f), VIDEO_DIR))
        elif os.path.isfile(full_path):
            video_list = [target]

    if not video_list:  # fallback → tutta la cartella base
        for root, _, files in os.walk(VIDEO_DIR):
            for f in files:
                if f.lower().endswith((".mp4", ".mov", ".avi", ".mkv")):
                    video_list.append(os.path.relpath(os.path.join(root, f), VIDEO_DIR))

    vid = random.choice(video_list)
    file_path = os.path.join(VIDEO_DIR, vid)
    duration = get_duration(file_path)
    length = random.randint(10, 25)
    start = random.uniform(0, max(0, duration - length))

    return jsonify({
        "file": vid,
        "start": round(start, 2),
        "length": length
    })

@app.route("/video/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEO_DIR, filename)

@app.route("/")
def root():
    return send_from_directory("static", "index.html")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)