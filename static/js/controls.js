"use strict";

// ---------------------------------------------------------------------
//  Text prompt modal
// ---------------------------------------------------------------------
function askText({ title, value = "", placeholder = "", ok = "Conferma" }, cb) {
  const wrap = document.getElementById("prompt-modal");
  const input = document.getElementById("promptInput");
  document.getElementById("promptTitle").textContent = title;
  document.getElementById("promptOk").textContent = ok;
  input.value = value;
  input.placeholder = placeholder;
  wrap._cb = cb;
  wrap.classList.remove("hidden");
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closePrompt() {
  document.getElementById("prompt-modal").classList.add("hidden");
}

function submitPrompt() {
  const wrap = document.getElementById("prompt-modal");
  const input = document.getElementById("promptInput");
  const value = input.value.trim() || input.placeholder;
  const cb = wrap._cb;
  closePrompt();
  if (value && cb) cb(value);
}

// ---------------------------------------------------------------------
//  Global controls
// ---------------------------------------------------------------------
function nextAll() {
  if (Smart.active) { Smart.evolve(); return; }
  for (const t of tiles.values()) t.advance();
}

function updatePauseBtn() {
  document.querySelector("#pauseBtn .material-icons-round").textContent =
    paused ? "play_arrow" : "pause";
}

function togglePause() {
  paused = !paused;
  updatePauseBtn();
  if (Smart.active) Smart.setPaused(paused);
  for (const t of tiles.values()) t.setPaused(paused);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---------------------------------------------------------------------
//  Topbar auto-hide
// ---------------------------------------------------------------------
let hideT = null;
function pokeTopbar() {
  document.getElementById("topbar").classList.remove("hidden");
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    if (!document.getElementById("sidebar").classList.contains("open")) {
      document.getElementById("topbar").classList.add("hidden");
      document.getElementById("layout-pop").classList.add("hidden");
    }
  }, 3500);
}
