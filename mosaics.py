"""Saved mosaics, shared by every client: one JSON file per mosaic.

They live under DATA_DIR/mosaics (a Docker volume), never in a database.
Writes go to a temp file first and are swapped in with os.replace(), so a
reader never sees half a file. Two clients editing the same mosaic at the
same time: the last write wins, which is fine for a kiosk.

Error messages are user-visible, so they are in Italian like the UI.
"""

import json
import logging
import os
import re
import tempfile
import time

log = logging.getLogger(__name__)

DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", "/app/data"))
MOSAIC_DIR = os.path.join(DATA_DIR, "mosaics")
MAX_TILES = 6

# Ids become file names: keep them to a boring alphabet.
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _path(mid):
    if not _ID.match(mid or ""):
        raise ValueError("Mosaico non valido")
    return os.path.join(MOSAIC_DIR, mid + ".json")


def list_all():
    out = []
    try:
        names = os.listdir(MOSAIC_DIR)
    except FileNotFoundError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(MOSAIC_DIR, name), encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, ValueError) as e:
            log.error("unreadable mosaic %s: %s", name, e)
    out.sort(key=lambda m: m.get("created", 0))
    return out


def save(mid, data):
    path = _path(mid)
    if not isinstance(data, dict) or not isinstance(data.get("tiles"), list):
        raise ValueError("Mosaico non valido")
    m = {
        "id": mid,
        "name": str(data.get("name") or "Mosaico")[:60],
        "preset": str(data.get("preset") or "auto"),
        "created": data.get("created") or int(time.time() * 1000),
        "tiles": [t for t in data["tiles"] if isinstance(t, dict)][:MAX_TILES],
    }
    os.makedirs(MOSAIC_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=MOSAIC_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False)
        os.chmod(tmp, 0o644)        # mkstemp makes it 0600; keep it readable for backups
        os.replace(tmp, path)
    except BaseException:
        os.remove(tmp)
        raise
    return m


def delete(mid):
    try:
        os.remove(_path(mid))
    except FileNotFoundError:
        pass
