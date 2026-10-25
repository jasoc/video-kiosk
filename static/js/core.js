// =====================================================================
//  Video Kiosk — tree + random clip loops + mosaic grid
//
//  Playback: each tile owns TWO <video> elements (double buffer), reused
//  forever. While one plays, the next clip is prefetched on the hidden
//  one, then swapped with a crossfade. No element is ever created per
//  clip, so client memory stays flat.
//
//  Per tile: one or more scopes mixed together (drop a library entry on
//  a tile to add one), mode "clips" (random clips, 5..60s) or "full"
//  (whole videos, with a seek bar), a zoom mode (fill / fit / smart crop)
//  and, per file, a cut: the part of the video to loop or draw clips from.
//  Mosaics (tiles + settings + geometry) are JSON files on the server,
//  shared by every client.
//
//  The grid does not gravitate: tiles stay exactly where they are put,
//  and a new tile only ever takes free space (or half of the biggest
//  tile when the canvas is full).
//
//  No build step: the files under js/ are classic scripts that share one
//  global scope, loaded in order by index.html. Each one only declares
//  things at load time; everything runs from main.js once the page has
//  loaded, so files may call into files loaded after them. This one
//  holds the constants and the shared state.
// =====================================================================

"use strict";

const MAX_TILES = 6;
const GRID_COLS = 12;
const GRID_ROWS = 12;
const PRESS_MS = 350;          // long-press before a tree drag starts
const DRAG_SLOP = 12;          // px of movement that cancels a press
const DURATIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const LEGACY_KEY = "kiosk.mosaics"; // pre-server localStorage mosaics

// Zoom cycle. "smart" crops the black bars baked inside the frame.
const ZOOMS = [
  { id: "fill",  icon: "crop",         title: "Riempi il tassello" },
  { id: "fit",   icon: "fit_screen",   title: "Adatta: nessun taglio" },
  { id: "smart", icon: "auto_fix_high", title: "Zoom automatico: toglie le bande nere" },
];

let grid;                      // GridStack instance
let paused = false;
let currentPreset = "auto";
let mosaicAudio = false;       // mosaic tiles play sound too (per device)
const tiles = new Map();       // gridstack item el -> Tile
let libFiles = [];             // every video path, in tree order

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
