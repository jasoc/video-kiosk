"""Video Kiosk backend — routes only.

The library scan lives in library.py, the file manager in fsops.py and the
low-res transcoder in proxy.py. The server never holds video bytes in
memory: /video streams straight from disk with Range support.
"""

import logging
import os
import random

from flask import Flask, jsonify, request, send_from_directory

import fsops
import library
import proxy

app = Flask(__name__, static_folder="static", static_url_path="")
app.logger.setLevel(logging.INFO)


@app.route("/")
def root():
    return send_from_directory("static", "index.html")


@app.route("/tree")
def tree():
    return jsonify(library.build_tree(library.ROOT_DIR))


@app.route("/video/<path:p>")
def video(p):
    # conditional=True enables HTTP Range responses: the client only pulls
    # the byte ranges it actually plays, and seeking is cheap.
    if request.args.get("q") == "low":
        name = proxy.low_res(p)
        if name:
            return send_from_directory(proxy.PROXY_DIR, name, conditional=True)
    return send_from_directory(library.ROOT_DIR, p, conditional=True)


@app.route("/random")
def random_clip():
    target = request.args.get("target", "").strip("/")
    clip_len = max(1.0, float(request.args.get("duration", 20)))

    videos = library.all_videos()
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
    abs_path = library.abspath(rel)
    if not os.path.isfile(abs_path):
        # The library moved under our feet (file manager or another client).
        library.invalidate()
        return jsonify({"error": "stale"}), 404
    dur = library.probe(abs_path)["dur"]
    if dur <= clip_len:
        start, length = 0.0, dur
    else:
        start = random.uniform(0, dur - clip_len)
        length = clip_len

    return jsonify({"file": rel, "start": round(start, 2),
                    "length": round(length, 2), "dur": round(dur, 2)})


# --- file manager -----------------------------------------------------
def _fs(fn, *args):
    try:
        return jsonify({"ok": True, "path": fn(*args)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        app.logger.error("fs op failed: %s", e)
        return jsonify({"error": "Operazione non riuscita"}), 400


@app.post("/fs/folder")
def fs_folder():
    d = request.get_json(silent=True) or {}
    return _fs(fsops.make_folder, d.get("parent", ""), d.get("name", ""))


@app.post("/fs/rename")
def fs_rename():
    d = request.get_json(silent=True) or {}
    return _fs(fsops.rename, d.get("path", ""), d.get("name", ""))


@app.post("/fs/move")
def fs_move():
    d = request.get_json(silent=True) or {}
    return _fs(fsops.move, d.get("src", ""), d.get("dest", ""))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, threaded=True)
