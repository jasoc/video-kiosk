"""Library scanning and per-file metadata.

Only metadata lives in memory (relative paths and ffprobe results); video
bytes are never cached here — they are streamed from disk with Range
support and cached for free by the OS page cache.
"""

import hashlib
import json
import logging
import os
import subprocess
import threading
import time

log = logging.getLogger(__name__)

ROOT_DIR = os.path.abspath(os.environ.get("VIDEOS_DIR", "/app/videos"))
VIDEO_EXT = (".mp4", ".mov", ".webm", ".avi", ".mkv")

LIST_TTL = 30.0
_list_cache = {"time": 0.0, "videos": [], "set": frozenset()}
_list_lock = threading.Lock()

# {abspath: {"dur", "width", "height"}} — ffprobe spawns a subprocess, so
# this must stay. Bounded by the number of files in the library.
_meta_cache = {}
_meta_lock = threading.Lock()


def abspath(rel):
    return os.path.join(ROOT_DIR, rel.strip("/").replace("/", os.sep))


def invalidate():
    """Force the next all_videos() to rescan (a pick vanished from disk)."""
    with _list_lock:
        _list_cache["time"] = 0.0


def all_videos():
    """Relative paths of every video under ROOT_DIR, cached for LIST_TTL."""
    with _list_lock:
        if time.monotonic() - _list_cache["time"] < LIST_TTL:
            return _list_cache["videos"]
    videos = []
    for root, dirs, files in os.walk(ROOT_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.lower().endswith(VIDEO_EXT):
                rel = os.path.relpath(os.path.join(root, f), ROOT_DIR)
                videos.append(rel.replace(os.sep, "/"))
    with _list_lock:
        _list_cache["time"] = time.monotonic()
        _list_cache["videos"] = videos
        _list_cache["set"] = frozenset(videos)
    return videos


def in_scope(videos, target):
    """Videos matching one scope: "" (all), an exact file, or a folder."""
    if not target:
        return videos
    if target in videos:
        return [target]
    prefix = target + "/"
    return [v for v in videos if v.startswith(prefix)]


def file_key(path):
    """Stable cache key of a file, on size+mtime so edits invalidate it.
    Proxies, thumbnails and analyses are all named after it."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = f"{st.st_size}:{int(st.st_mtime)}".encode()
    return hashlib.sha1(key).hexdigest()[:16]


def is_video(rel):
    """True if `rel` is a video of the library. Use it before turning a
    client-supplied path into a filesystem path."""
    all_videos()
    with _list_lock:
        return rel in _list_cache["set"]


def probe(path):
    """Duration and pixel size of a video, from ffprobe (cached)."""
    key = (path, _mtime(path))
    with _meta_lock:
        if key in _meta_cache:
            return _meta_cache[key]
    meta = {"dur": 60.0, "width": 0, "height": 0}
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration",
             "-of", "json", path],
            stderr=subprocess.DEVNULL,
        )
        info = json.loads(out)
        meta["dur"] = float(info["format"]["duration"])
        stream = (info.get("streams") or [{}])[0]
        meta["width"] = int(stream.get("width") or 0)
        meta["height"] = int(stream.get("height") or 0)
    except Exception as e:
        log.error("ffprobe failed for %s: %s", path, e)
    with _meta_lock:
        _meta_cache[key] = meta
    return meta


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def build_tree(path):
    items = []
    try:
        entries = sorted(os.listdir(path), key=str.lower)
    except OSError:
        return items
    for name in entries:
        if name.startswith("."):
            continue
        fp = os.path.join(path, name)
        rel = os.path.relpath(fp, ROOT_DIR).replace(os.sep, "/")
        if os.path.isdir(fp):
            items.append({"type": "dir", "name": name, "path": rel,
                          "children": build_tree(fp)})
        elif name.lower().endswith(VIDEO_EXT):
            items.append({"type": "file", "name": name, "path": rel})
    return items
