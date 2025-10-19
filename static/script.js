let player, nextTimer, currentTarget = "";
let fixedDuration = null; // seconds or null if random

async function fetchTree() {
  const res = await fetch("/tree");
  const tree = await res.json();
  const container = document.getElementById("tree");
  container.innerHTML = "";
  renderTree(tree, container);
}

function renderTree(nodes, parent) {
  nodes.forEach(node => {
    const item = document.createElement("div");
    item.className = `node ${node.type}`;

    if (node.type === "dir") {
      const header = document.createElement("div");
      header.className = "dir-header";

      const toggle = document.createElement("button");
      toggle.textContent = "▶";
      toggle.className = "dir-toggle";
      toggle.onclick = (e) => {
        e.stopPropagation();
        item.classList.toggle("open");
        toggle.textContent = item.classList.contains("open") ? "▼" : "▶";
      };

      const label = document.createElement("span");
      label.className = "dirname";
      label.textContent = node.name;

      const playBtn = document.createElement("button");
      playBtn.textContent = "🎬";
      playBtn.className = "dir-play";
      playBtn.title = "Riproduci questa cartella";
      playBtn.onclick = (e) => {
        e.stopPropagation();
        currentTarget = node.path;
        clearTimeout(nextTimer);
        loadRandom();
      };

      header.append(toggle, label, playBtn);
      item.appendChild(header);

      const children = document.createElement("div");
      children.className = "children";
      renderTree(node.children, children);
      item.appendChild(children);
    } else {
      const label = document.createElement("span");
      label.textContent = node.name;
      label.className = "filename";
      label.onclick = (e) => {
        e.stopPropagation();
        currentTarget = node.path;
        clearTimeout(nextTimer);
        loadRandom();
      };
      item.appendChild(label);
    }

    parent.appendChild(item);
  });
}

// --- RIPRODUZIONE RANDOM O FISSA ---
async function loadRandom() {
  clearTimeout(nextTimer);
  const url = currentTarget ? `/random?target=${encodeURIComponent(currentTarget)}` : "/random";
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return console.error("Nessun video trovato");

  player.src = `/video/${data.file}#t=${data.start}`;
  await player.play();

  // Se è impostata una durata fissa, usa quella invece di data.length
  const length = fixedDuration ?? data.length;
  nextTimer = setTimeout(loadRandom, length * 1000);
}

// --- INIT ---
window.onload = () => {
  player = document.getElementById("player");
  const nextBtn = document.getElementById("nextBtn");
  const zoomBtn = document.getElementById("zoomBtn");
  const menuBtn = document.getElementById("menuBtn");
  const closeSidebar = document.getElementById("closeSidebar");
  const sidebar = document.getElementById("sidebar");

  const randomCheck = document.getElementById("randomCheck");
  const durationContainer = document.getElementById("durationContainer");
  const slider = document.getElementById("durationSlider");
  const durValue = document.getElementById("durValue");

  nextBtn.onclick = loadRandom;
  zoomBtn.onclick = () => player.classList.toggle("fill");
  menuBtn.onclick = () => sidebar.classList.add("open");
  closeSidebar.onclick = () => sidebar.classList.remove("open");

  // --- Gestione durata ---
  slider.addEventListener("input", () => {
    durValue.textContent = slider.value;
    if (!randomCheck.checked) {
      fixedDuration = parseInt(slider.value);
    }
  });

  randomCheck.addEventListener("change", () => {
    if (randomCheck.checked) {
      fixedDuration = null;
      durationContainer.classList.remove("active");
    } else {
      fixedDuration = parseInt(slider.value);
      durationContainer.classList.add("active");
    }
  });

  // attivo/disattivo slider in base a stato iniziale
  if (!randomCheck.checked) durationContainer.classList.add("active");

  fetchTree();
  loadRandom();
};