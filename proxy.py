"""On-demand low-resolution proxies, so a mosaic of many tiles stays smooth.

A tablet cannot decode six 4K streams at once. When the client plays more
than one tile it asks for `?q=low`; if a proxy for that file already exists
it is served, otherwise the original is served *immediately* and the proxy
is built in the background for next time. Playback never waits on ffmpeg.

Proxies are files on disk (PROXY_DIR), never bytes in memory, and there is
at most one transcode running at a time so the box stays responsive.
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

_queued = set()
_failed = set()          # give up after one failure instead of looping
_lock = threading.Lock()
_jobs = queue.Queue()


def low_res(rel):
    """Proxy file name for `rel` if ready, else None (and queue a build)."""
    src = library.abspath(rel)
    if not os.path.isfile(src):
        return None
    name = _name(src)
    if name is None:
        return None
    if os.path.isfile(os.path.join(PROXY_DIR, name)):
        return name
    _enqueue(rel, src, name)
    return None


def _name(src):
    """Stable proxy name, keyed on size+mtime so edits invalidate it."""
    try:
        st = os.stat(src)
    except OSError:
        return None
    key = f"{st.st_size}:{int(st.st_mtime)}".encode()
    return hashlib.sha1(key).hexdigest()[:16] + ".mp4"


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
