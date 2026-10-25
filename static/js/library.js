"use strict";

// Files were moved or deleted (outside the app) while a tile was playing.
// Say so and reload the tree; playback recovers on its own with the next
// clip.
let troubleAt = 0;
function libraryTrouble() {
  if (Date.now() - troubleAt < 15000) return;
  troubleAt = Date.now();
  toast("Ohoh, non trovo il video — aggiorno la libreria");
  loadTree();
}

// ---------------------------------------------------------------------
//  Library: one folder at a time as a grid of cards with a preview frame
//  (/thumb, built once on the server and cached). Tap a folder to open
//  it, a video to play it; the bar above plays / mosaics the open folder.
// ---------------------------------------------------------------------
let libTree = [];              // /tree data
let navPath = "";              // folder shown in the grid ("" = root)

async function loadTree() {
  let data;
  try { data = await (await fetch("/tree")).json(); }
  catch (e) { return; }
  libTree = data;
  libFiles = [];
  const collect = ns => ns.forEach(n => n.type === "dir" ? collect(n.children) : libFiles.push(n.path));
  collect(data);
  renderLibrary();
  if (homeShown()) renderHome();
}

// Children of the folder at `path`, or null if it is gone.
function folderAt(path) {
  let nodes = libTree;
  if (!path) return nodes;
  for (const part of path.split("/")) {
    const d = nodes.find(n => n.type === "dir" && n.name === part);
    if (!d) return null;
    nodes = d.children;
  }
  return nodes;
}

const firstFile = n => n.type === "file" ? n.path
  : n.children.reduce((f, c) => f || firstFile(c), null);
const countFiles = n => n.type === "file" ? 1
  : n.children.reduce((k, c) => k + countFiles(c), 0);
const thumbUrl = file => `/thumb/${encodePath(file)}`;

function openFolder(path) {
  navPath = path;
  renderLibrary();
  document.getElementById("library").scrollTop = 0;
}

function renderLibrary() {
  let nodes = folderAt(navPath);
  if (!nodes) { navPath = ""; nodes = libTree; }

  const crumbs = document.getElementById("crumbs");
  crumbs.replaceChildren();
  const parts = navPath ? navPath.split("/") : [];
  ["", ...parts].forEach((name, i) => {
    const path = parts.slice(0, i).join("/");
    const b = document.createElement("button");
    b.className = "crumb" + (i === parts.length ? " here" : "");
    b.textContent = i ? name : "Tutti i video";
    b.addEventListener("click", () => openFolder(path));
    if (i) crumbs.append(Object.assign(document.createElement("span"),
                                       { className: "crumb-sep", textContent: "/" }));
    crumbs.append(b);
  });
  crumbs.scrollLeft = crumbs.scrollWidth;

  const box = document.getElementById("library");
  box.replaceChildren();
  if (!nodes.length) {
    const p = document.createElement("p");
    p.className = "sb-hint";
    p.textContent = "Cartella vuota";
    box.append(p);
  }
  nodes.forEach((n, i) => {
    const card = libCard(n);
    card.style.setProperty("--i", Math.min(i, 24));    // cascade in
    box.append(card);
  });
}

function libCard(n) {
  const dir = n.type === "dir";
  const card = document.createElement("div");
  card.className = "lib-card" + (dir ? " dir" : "");
  const thumb = document.createElement("div");
  thumb.className = "lib-thumb";
  thumb.innerHTML = `<span class="material-icons-round">${dir ? "folder" : "movie"}</span>`;
  const file = firstFile(n);
  if (file) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = thumbUrl(file);
    img.onerror = () => img.remove();
    thumb.append(img);
  }
  if (dir) {
    const badge = document.createElement("span");
    badge.className = "lib-badge";
    badge.innerHTML = `<span class="material-icons-round">folder</span>${countFiles(n)}`;
    thumb.append(badge);
    const play = rowAction("play_arrow", "Riproduci", () => playScope(n.path));
    play.classList.add("lib-play");
    thumb.append(play);
  }
  const name = document.createElement("span");
  name.className = "lib-name";
  name.textContent = n.name;
  card.append(thumb, name);
  card.addEventListener("click", () => {
    if (card._dragged) { card._dragged = false; return; }
    dir ? openFolder(n.path) : playScope(n.path);
  });
  makeDraggable(card, n.path);
  return card;
}
