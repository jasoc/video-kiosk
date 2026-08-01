"""File manager operations on the library: new folder, rename, move.

Deletion is deliberately not implemented — the kiosk may reorganise the
library but must never destroy it.

Every path coming from the client is resolved with realpath() and checked
to be inside ROOT_DIR before anything touches the filesystem. Error
messages are user-visible, so they are in Italian like the rest of the UI.
"""

import os
import shutil

import library

BAD_CHARS = set('/\\:*?"<>|')


def _safe_name(name):
    name = (name or "").strip()
    if not name or name.startswith(".") or any(c in BAD_CHARS for c in name):
        raise ValueError("Nome non valido")
    return name


def _resolve(rel):
    """Absolute path of a library-relative path, guaranteed inside ROOT_DIR."""
    rel = (rel or "").strip("/").replace("/", os.sep)
    path = os.path.realpath(os.path.join(library.ROOT_DIR, rel))
    root = os.path.realpath(library.ROOT_DIR)
    if path != root and not path.startswith(root + os.sep):
        raise ValueError("Percorso non valido")
    return path


def _rel(path):
    rel = os.path.relpath(path, os.path.realpath(library.ROOT_DIR))
    return "" if rel == "." else rel.replace(os.sep, "/")


def make_folder(parent, name):
    dst = os.path.join(_resolve(parent), _safe_name(name))
    if os.path.exists(dst):
        raise ValueError("Esiste già")
    os.makedirs(dst)
    library.invalidate()
    return _rel(dst)


def rename(path, name):
    src = _resolve(path)
    if src == os.path.realpath(library.ROOT_DIR):
        raise ValueError("Percorso non valido")
    if not os.path.exists(src):
        raise ValueError("Non trovato")
    name = _safe_name(name)
    if os.path.isfile(src):
        # Keep the extension: renaming a .mp4 to something else would hide
        # it from the library.
        base, ext = os.path.splitext(name)
        if ext.lower() not in library.VIDEO_EXT:
            name = base + os.path.splitext(src)[1]
    dst = os.path.join(os.path.dirname(src), name)
    if os.path.exists(dst):
        raise ValueError("Esiste già")
    os.rename(src, dst)
    library.invalidate()
    return _rel(dst)


def move(src_rel, dest_rel):
    src = _resolve(src_rel)
    dest = _resolve(dest_rel)
    if src == os.path.realpath(library.ROOT_DIR):
        raise ValueError("Percorso non valido")
    if not os.path.exists(src):
        raise ValueError("Non trovato")
    if not os.path.isdir(dest):
        raise ValueError("Destinazione non valida")
    if dest == src or dest.startswith(src + os.sep):
        raise ValueError("Non puoi spostare una cartella dentro se stessa")
    dst = os.path.join(dest, os.path.basename(src))
    if os.path.exists(dst):
        raise ValueError("Esiste già un elemento con questo nome")
    shutil.move(src, dst)
    library.invalidate()
    return _rel(dst)
