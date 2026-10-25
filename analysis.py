"""Video analysis for the "regia" (smart mosaic). No machine learning.

One ffmpeg pass per file, at SAMPLE_FPS frames per second and 160 px wide,
reading the numbers ffmpeg's own filters print for every sampled frame:

  scene_score  how different a frame is from the previous one → shot cuts
  YDIF         average pixel change → how much the picture moves
  YAVG         brightness → dark frames / fades are left out
  UAVG, VAVG   average chroma → the dominant colour of a shot
  cropdetect   black bars baked into the frame → the real content box

The result, one small JSON per file under DATA_DIR/analysis (named by
library.file_key, so it survives renames and is redone if the file
changes), describes the file's real orientation and its list of shots.

One worker thread, ffmpeg under `nice`, files queued on demand (the folders
the regia is using first). Pausing kills the running ffmpeg and puts that
file back at the front of the queue. Everything here is metadata: the
in-memory state is a queue of paths and a few counters.
"""

import collections
import json
import logging
import os
import random
import subprocess
import tempfile
import threading
import time

import library
import mosaics

log = logging.getLogger(__name__)

ANALYSIS_DIR = os.path.join(mosaics.DATA_DIR, "analysis")
VERSION = 1
SAMPLE_FPS = 4
SAMPLE_W = 160
SCENE_CUT = 0.30        # scene_score at or above this is a cut
MIN_SHOT = 1.5          # shorter shots are merged into the previous one
POOL_MAX = 400          # files sent to the client per request, at most

_q = collections.deque()
_queued = set()
_cv = threading.Condition()
_state = {
    "paused": False,
    "current": None,      # relative path being analysed
    "progress": 0.0,      # 0..1 within the current file
    "batch": 0,           # files queued since the queue was last empty
    "done": 0,            # ... of which finished
    "failed": 0,          # ... of which failed
    "avg": None,          # seconds per file, moving average
    "proc": None,         # running ffmpeg, so pause can stop it
}
_lib_cov = {"time": 0.0, "value": (0, 0)}


def _path(rel):
    key = library.file_key(library.abspath(rel))
    return key and os.path.join(ANALYSIS_DIR, key + ".json")


def is_ready(rel):
    p = _path(rel)
    return bool(p) and os.path.isfile(p)


def load(rel):
    p = _path(rel)
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if data.get("v") == VERSION else None
    except (OSError, TypeError, ValueError):
        return None


def files_in(targets):
    videos = library.all_videos()
    seen, out = set(), []
    for t in targets:
        for v in library.in_scope(videos, t):
            if v not in seen:
                seen.add(v)
                out.append(v)
    return out


def enqueue(targets):
    """Queue every not-yet-analysed video of `targets`, ahead of the rest."""
    todo = [v for v in files_in(targets) if v not in _queued and not is_ready(v)]
    with _cv:
        if not _q and _state["current"] is None:
            _state.update(batch=0, done=0, failed=0)
        for v in reversed(todo):
            if v not in _queued:
                _q.appendleft(v)
                _queued.add(v)
        _state["batch"] += len(todo)
        _cv.notify()
    return len(todo)


def set_paused(paused):
    with _cv:
        _state["paused"] = bool(paused)
        proc = _state["proc"]
        _cv.notify()
    if paused and proc:
        proc.terminate()


def status(targets=()):
    with _cv:
        st = {k: v for k, v in _state.items() if k != "proc"}
        st["queued"] = len(_q)
    remaining = st["queued"] + (1 - st["progress"] if st["current"] else 0)
    st["eta"] = round(remaining * st["avg"]) if st["avg"] else None
    st["coverage"] = {t: _coverage(files_in([t])) for t in targets}
    st["library"] = _library_coverage()
    return st


def _coverage(files):
    return [sum(1 for v in files if is_ready(v)), len(files)]


def _library_coverage():
    # One stat per video: cheap, but no need to redo it on every poll.
    if time.monotonic() - _lib_cov["time"] > 10:
        _lib_cov["value"] = _coverage(library.all_videos())
        _lib_cov["time"] = time.monotonic()
    return _lib_cov["value"]


def pool(targets, skip=()):
    """Analyses of the videos in `targets` that are ready (a random sample
    of POOL_MAX if there are more), for the client's director."""
    files = [v for v in files_in(targets) if v not in skip and is_ready(v)]
    if len(files) > POOL_MAX:
        files = random.sample(files, POOL_MAX)
    out = []
    for v in files:
        data = load(v)
        if data:
            data["file"] = v          # the path may have changed since
            out.append(data)
    return out


# --- the worker -------------------------------------------------------
def _worker():
    while True:
        with _cv:
            while not _q or _state["paused"]:
                _cv.wait()
            rel = _q.popleft()
            _state["current"] = rel
            _state["progress"] = 0.0
        t0 = time.monotonic()
        try:
            ok = _analyze(rel)
        except Exception as e:
            log.error("analysis failed for %s: %s", rel, e)
            ok = False
        with _cv:
            _state["current"] = None
            _state["proc"] = None
            if ok is None:                # stopped by pause: try again later
                _q.appendleft(rel)
                continue
            _queued.discard(rel)
            _state["done" if ok else "failed"] += 1
            el = time.monotonic() - t0
            _state["avg"] = el if _state["avg"] is None else _state["avg"] * 0.7 + el * 0.3
        _lib_cov["time"] = 0.0


def _probe(src):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:stream_tags=rotate:"
         "stream_side_data=rotation:format=duration", "-of", "json", src],
        stderr=subprocess.DEVNULL, timeout=30,
    )
    info = json.loads(out)
    s = (info.get("streams") or [{}])[0]
    rot = 0
    for sd in s.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    rot = int((s.get("tags") or {}).get("rotate", rot))
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)
    if abs(rot) % 180 == 90:              # ffmpeg/browsers show it rotated
        w, h = h, w
    return w, h, float(info["format"]["duration"])


def _analyze(rel):
    """True when done, False on failure, None when stopped by a pause."""
    if not library.is_video(rel):
        return False
    src = library.abspath(rel)
    dest = _path(rel)
    if not dest:
        return False
    w, h, dur = _probe(src)
    if not (w and h and dur > 0):
        return False

    vf = (f"fps={SAMPLE_FPS},scale={SAMPLE_W}:-2,"
          "cropdetect=limit=24:round=2:reset=0,"
          r"select=gte(scene\,0),signalstats,"
          "metadata=print:file=/dev/stdout")
    proc = subprocess.Popen(
        ["nice", "-n", "15", "ffmpeg", "-v", "error", "-nostdin", "-threads", "2",
         "-i", src, "-an", "-sn", "-dn", "-vf", vf, "-f", "null", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    with _cv:
        _state["proc"] = proc

    samples, cur, crop = [], None, {}
    for line in proc.stdout:
        if line.startswith("frame:"):
            t = float(line.rsplit("pts_time:", 1)[1])
            cur = {"t": t}
            samples.append(cur)
            with _cv:
                _state["progress"] = min(1.0, t / dur)
        elif cur is not None and line.startswith("lavfi."):
            k, _, v = line.strip().partition("=")
            k = k.rsplit(".", 1)[1]
            if k in ("scene_score", "YAVG", "UAVG", "VAVG", "YDIF"):
                cur[k] = float(v)
            elif k in ("x", "y", "w", "h") and "cropdetect" in line:
                crop[k] = float(v)
    proc.wait()
    with _cv:
        if _state["paused"]:
            return None
    if proc.returncode != 0 or not samples:
        return False

    # Content box from cropdetect (in the 160 px wide sample frame).
    sh = round(SAMPLE_W * h / w / 2) * 2
    box = None
    if len(crop) == 4 and crop["w"] > 0 and crop["h"] > 0:
        box = [crop["x"] / SAMPLE_W, crop["y"] / sh, crop["w"] / SAMPLE_W, crop["h"] / sh]
        if box[2] * box[3] > 0.9:         # no real bars
            box = None
    aspect = (w * box[2]) / (h * box[3]) if box else w / h

    # Shots: cut where the scene score jumps, merge the very short ones.
    cuts = [0.0] + [s["t"] for s in samples[1:] if s.get("scene_score", 0) >= SCENE_CUT]
    bounds = []
    for a, b in zip(cuts, cuts[1:] + [dur]):
        if bounds and (b - a < MIN_SHOT or bounds[-1][1] - bounds[-1][0] < MIN_SHOT):
            bounds[-1][1] = b
        else:
            bounds.append([a, b])
    shots = []
    for a, b in bounds:
        seg = [s for s in samples if a <= s["t"] < b]
        if not seg:
            continue
        # The first sample of a shot carries the cut itself: not motion.
        moving = seg[1:] or seg
        avg = lambda k, ss: sum(s.get(k, 0) for s in ss) / len(ss)
        shots.append([round(a, 2), round(b, 2), round(avg("YDIF", moving), 2),
                      round(avg("YAVG", seg), 1), round(avg("UAVG", seg), 1),
                      round(avg("VAVG", seg), 1)])

    data = {"v": VERSION, "file": rel, "dur": round(dur, 2), "w": w, "h": h,
            "aspect": round(aspect, 3),
            "crop": [round(c, 3) for c in box] if box else None,
            "shots": shots}   # [start, end, motion, luma, u, v]
    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=ANALYSIS_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, dest)
    log.info("analysed %s: %d shots", rel, len(shots))
    return True


threading.Thread(target=_worker, daemon=True).start()
