"""On-demand low-resolution proxies and thumbnails.

A tablet cannot decode six 4K streams at once. When the client plays more
than one tile it asks for `?q=low`; if a proxy for that file already exists
it is served, otherwise the original is served *immediately* and the proxy
is built in the background for next time. Playback never waits on ffmpeg.

Proxies are files on disk (PROXY_DIR), never bytes in memory, and there is
at most one transcode running at a time so the box stays responsive.

Thumbnails (one small JPEG frame per video, for the library grid) are the
one thing built inside a request: grabbing a single frame takes a fraction
of a second, at most THUMB_JOBS run at once, and the result is cached on
disk (PROXY_DIR/thumbs) forever.

Every client-supplied path is checked against the library list first.
"""

import hashlib
import logging
import os
import queue
import subprocess
import threading

import library

log = logging.getLogger(__name__)

PROXY_DIR = os.path.abspath(os.environ.get("PROXY_DIR", "/app/proxies"))
PROXY_HEIGHT = 540      # target height of a proxy
MIN_HEIGHT = 720        # anything smaller is already cheap enough to decode
THUMB_DIR = os.path.join(PROXY_DIR, "thumbs")
THUMB_WIDTH = 360
THUMB_JOBS = 2
_thumb_sem = threading.Semaphore(THUMB_JOBS)

_queued = set()
_failed = set()          # give up after one failure instead of looping
_lock = threading.Lock()
_jobs = queue.Queue()


def low_res(rel):
    """Proxy file name for `rel` if ready, else None (and queue a build)."""
    if not library.is_video(rel):
        return None
    src = library.abspath(rel)
    key = _key(src)
    if key is None:
        return None
    name = key + ".mp4"
    if os.path.isfile(os.path.join(PROXY_DIR, name)):
        return name
    _enqueue(rel, src, name)
    return None


def thumb(rel):
    """Thumbnail file name for `rel`, built on first request, or None."""
    if not library.is_video(rel):
        return None
    src = library.abspath(rel)
    key = _key(src)
    if key is None:
        return None
    name = key + ".jpg"
    path = os.path.join(THUMB_DIR, name)
    if os.path.isfile(path):
        return name
    with _thumb_sem:
        if os.path.isfile(path):          # built while we waited
            return name
        tmp = path + ".part.jpg"
        try:
            os.makedirs(THUMB_DIR, exist_ok=True)
            at = library.probe(src)["dur"] * 0.1   # skip black intros
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", src,
                 "-frames:v", "1", "-vf", f"scale={THUMB_WIDTH}:-2", "-q:v", "5", tmp],
                check=True, stderr=subprocess.DEVNULL, timeout=30,
            )
            os.replace(tmp, path)
        except Exception as e:
            log.error("thumbnail failed for %s: %s", rel, e)
            try:
                os.remove(tmp)
            except OSError:
                pass
            return None
    return name


def _key(src):
    """Stable cache key of a source file, on size+mtime so edits invalidate it."""
    try:
        st = os.stat(src)
    except OSError:
        return None
    key = f"{st.st_size}:{int(st.st_mtime)}".encode()
    return hashlib.sha1(key).hexdigest()[:16]


def _enqueue(rel, src, name):
    with _lock:
        if name in _queued or name in _failed:
            return
        # Small videos decode fine as they are — don't waste CPU on them.
        if library.probe(src)["height"] <= MIN_HEIGHT:
            return
        _queued.add(name)
    _jobs.put((rel, src, name))


def _worker():
    while True:
        rel, src, name = _jobs.get()
        dst = os.path.join(PROXY_DIR, name)
        tmp = dst + ".part"
        try:
            os.makedirs(PROXY_DIR, exist_ok=True)
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", src,
                 "-vf", f"scale=-2:{PROXY_HEIGHT}",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                 "-an", "-movflags", "+faststart", tmp],
                check=True, stderr=subprocess.DEVNULL,
            )
            os.replace(tmp, dst)
            log.info("proxy built for %s", rel)
        except Exception as e:
            log.error("proxy failed for %s: %s", rel, e)
            with _lock:
                _failed.add(name)
            try:
                os.remove(tmp)
            except OSError:
                pass
        finally:
            with _lock:
                _queued.discard(name)
            _jobs.task_done()


threading.Thread(target=_worker, daemon=True).start()
