"""Video Kiosk backend — routes only.

The library scan lives in library.py, saved mosaics in mosaics.py and the
low-res transcoder in proxy.py. The server never holds video bytes in
memory: /video streams straight from disk with Range support.
"""

import logging
import os
import random

from flask import Flask, jsonify, request, send_from_directory

import library
import mosaics
import proxy

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024   # a mosaic is a few hundred bytes
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


def _pool(videos, target):
    """Videos matching one scope: "" (all), an exact file, or a folder."""
    if not target:
        return videos
    if target in videos:
        return [target]
    prefix = target + "/"
    return [v for v in videos if v.startswith(prefix)]


@app.route("/random")
def random_clip():
    # A tile can mix several scopes (repeated `target`). Pick a scope first,
    # then a file in it, so a small folder isn't drowned by a big one.
    targets = [t.strip("/") for t in request.args.getlist("target")] or [""]
    clip_len = max(1.0, float(request.args.get("duration", 20)))

    videos = library.all_videos()
    pools = [p for p in (_pool(videos, t) for t in targets) if p]
    if not pools:
        return jsonify({"error": "no videos"}), 404

    rel = random.choice(random.choice(pools))
    abs_path = library.abspath(rel)
    if not os.path.isfile(abs_path):
        # The library changed under our feet (files moved outside the app).
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


# --- saved mosaics ----------------------------------------------------
@app.get("/mosaics")
def mosaic_list():
    return jsonify(mosaics.list_all())


@app.put("/mosaics/<mid>")
def mosaic_put(mid):
    try:
        return jsonify(mosaics.save(mid, request.get_json(silent=True)))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        app.logger.error("mosaic save failed: %s", e)
        return jsonify({"error": "Salvataggio non riuscito"}), 500


@app.delete("/mosaics/<mid>")
def mosaic_delete(mid):
    try:
        mosaics.delete(mid)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        app.logger.error("mosaic delete failed: %s", e)
        return jsonify({"error": "Eliminazione non riuscita"}), 500
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, threaded=True)
