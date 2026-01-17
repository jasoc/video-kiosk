let player, preloader;
let currentClip = null, currentVideo = null;
let scopePath = "";
let clipDuration = 20;
let clipHistory = [], historyIndex = -1;
let sessionId = null;
let isFullscreen = false;
let hideTimeout = null;
let isPaused = false;
let currentlyCaching = null;
let allVideos = [];
let clipQueue = [];
let isPlaying = false;

const MAX_VIDEO_QUEUE = 5; // Fixed queue size

// -------------------------------------------------------------
//  Session management
// -------------------------------------------------------------
async function startSession() {
  sessionId = "s_" + Date.now();
  
  await fetch("/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sessionId })
  });
  pollCacheStatus();
}

async function endSession() {
  if (sessionId) {
    await fetch("/session/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId })
    });
  }
}

// -------------------------------------------------------------
//  Cache status polling
// -------------------------------------------------------------
let cacheInterval = null;

function pollCacheStatus() {
  if (cacheInterval) return;
  updateCacheBar();
  cacheInterval = setInterval(updateCacheBar, 2000);
}

async function updateCacheBar() {
  try {
    const res = await fetch("/cache/status");
    const data = await res.json();
    const pct = data.total > 0 ? (data.cached / data.total) * 100 : 0;
    const bar = document.getElementById("cache-progress");
    if (bar) {
      bar.style.width = pct + "%";
      if (pct >= 100) {
        bar.parentElement.classList.add("complete");
      } else {
        bar.parentElement.classList.remove("complete");
      }
    }
    currentlyCaching = data.caching || null;
    allVideos = data.videos || [];
    updatePlaylistPopup();
  } catch (e) {}
}

// -------------------------------------------------------------
//  Video CONTROL CORE
// -------------------------------------------------------------
async function fetchClip() {
  const params = new URLSearchParams();
  if (scopePath) params.set("target", scopePath);
  params.set("duration", clipDuration);
  
  const clip = await (await fetch(`/random?${params.toString()}`)).json();
  if (clip.error) return null;
  return clip;
}

async function fillQueue() {
  while (clipQueue.length < MAX_VIDEO_QUEUE) {
    const clip = await fetchClip();
    if (!clip) break;
    clipQueue.push(clip);
    // Preload video in background
    const preloadEl = document.createElement("video");
    preloadEl.src = `/video/${clip.file}`;
    preloadEl.preload = "auto";
    preloadEl.load();
  }
  updatePlaylistPopup();
}

function updateCurrentFolder() {
  const el = document.getElementById("folder-text");
  if (el) {
    el.textContent = scopePath ? scopePath : "/ root";
  }
}

function updateNowPlaying() {
  const el = document.getElementById("now-playing-text");
  if (el && currentVideo) {
    el.textContent = currentVideo.split("/").pop();
  } else if (el) {
    el.textContent = "Nothing playing";
  }
}

async function nextClip() {
  let clip;
  
  // Try to get from queue first
  if (clipQueue.length > 0) {
    clip = clipQueue.shift();
  } else {
    clip = await fetchClip();
  }
  
  if (!clip) {
    console.error("No clips available");
    return;
  }

  currentClip = clip;
  currentVideo = clip.file;
  clipHistory.splice(historyIndex + 1);
  clipHistory.push(clip);
  historyIndex = clipHistory.length - 1;
  
  updateCurrentFolder();
  updateNowPlaying();
  playClip(clip);
  
  // Refill queue in background
  fillQueue();
}

// -------------------------------------------------------------
//  Playback logic
// -------------------------------------------------------------
function playClip(clip, fullMode = false) {
  clearTimeout(player.nextT);
  const sameFile = player.dataset.src === clip.file;

  if (!sameFile) {
    player.src = `/video/${clip.file}`;
    player.dataset.src = clip.file;
  }

  const seekNow = () => {
    try { player.currentTime = clip.start; } catch (e) {}
    player.muted = false;
    player.play().catch(() => {});
  };

  if (player.readyState < 1) {
    player.addEventListener("loadedmetadata", seekNow, { once: true });
    player.load();
  } else {
    seekNow();
  }

  player.controls = fullMode;

  if (!fullMode && clip.length > 0) {
    player.nextT = setTimeout(nextClip, clip.length * 1000);
  }
}

// -------------------------------------------------------------
//  Controls
// -------------------------------------------------------------
function prevClip() {
  if (historyIndex > 0) {
    historyIndex--;
    const clip = clipHistory[historyIndex];
    currentClip = clip;
    updateNowPlaying();
    playClip(clip);
  }
}

function fullVideo() {
  if (!currentVideo) return;
  clearTimeout(player.nextT);
  currentClip = { file: currentVideo, start: 0, length: 9999 };
  playClip(currentClip, true);
}

function fullReset() {
  scopePath = "";
  clipQueue = [];
  updateCurrentFolder();
  nextClip();
}

function setClipDuration(dur) {
  clipDuration = dur;
  document.querySelectorAll(".dur-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.dur) === dur);
  });
  // Clear and refill queue with new duration
  clipQueue = [];
  fillQueue();
}

// -------------------------------------------------------------
//  Fullscreen mode
// -------------------------------------------------------------
function toggleFullscreen() {
  const viewer = document.getElementById("viewer");
  const btn = document.getElementById("fullscreenBtn");
  const icon = btn.querySelector(".material-icons");
  
  if (!isFullscreen) {
    if (viewer.requestFullscreen) {
      viewer.requestFullscreen();
    } else if (viewer.webkitRequestFullscreen) {
      viewer.webkitRequestFullscreen();
    }
    isFullscreen = true;
    document.body.classList.add("fullscreen-mode");
    icon.textContent = "fullscreen_exit";
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    isFullscreen = false;
    document.body.classList.remove("fullscreen-mode");
    icon.textContent = "fullscreen";
  }
}

function startAutoHide() {
  showTopbar();
  document.addEventListener("mousemove", showTopbar);
  document.addEventListener("touchstart", showTopbar);
}

function showTopbar() {
  const topbar = document.getElementById("topbar");
  topbar.classList.remove("hidden");
  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    topbar.classList.add("hidden");
  }, 3000);
}

// Handle fullscreen exit via Escape key
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && isFullscreen) {
    isFullscreen = false;
    document.body.classList.remove("fullscreen-mode");
    const icon = document.querySelector("#fullscreenBtn .material-icons");
    if (icon) icon.textContent = "fullscreen";
  }
});

// -------------------------------------------------------------
//  Pause / Resume
// -------------------------------------------------------------
function togglePause() {
  const btn = document.getElementById("pauseBtn");
  const icon = btn.querySelector(".material-icons");
  
  if (isPaused) {
    player.play();
    isPaused = false;
    icon.textContent = "pause";
    btn.title = "Pause";
    // Resume timer if not in full mode
    if (currentClip && currentClip.length < 9999) {
      const remaining = (currentClip.start + currentClip.length) - player.currentTime;
      if (remaining > 0) {
        player.nextT = setTimeout(nextClip, remaining * 1000);
      }
    }
  } else {
    player.pause();
    isPaused = true;
    icon.textContent = "play_arrow";
    btn.title = "Resume";
    clearTimeout(player.nextT);
  }
}

// -------------------------------------------------------------
//  Playlist Popup
// -------------------------------------------------------------
function togglePlaylistPopup() {
  const popup = document.getElementById("playlist-popup");
  popup.classList.toggle("hidden");
  if (!popup.classList.contains("hidden")) {
    updatePlaylistPopup();
  }
}

function updatePlaylistPopup() {
  const cachingEl = document.getElementById("playlist-caching");
  const listEl = document.getElementById("playlist-list");
  
  if (!cachingEl || !listEl) return;
  
  if (currentlyCaching) {
    cachingEl.innerHTML = `<span class="material-icons" style="font-size:16px">downloading</span> Caching: ${currentlyCaching.split("/").pop()}`;
  } else {
    cachingEl.innerHTML = `<span class="material-icons" style="font-size:16px">check_circle</span> All videos cached`;
  }
  
  listEl.innerHTML = "";
  
  // Show history (past clips)
  clipHistory.forEach((clip, i) => {
    const item = document.createElement("div");
    item.className = "playlist-item";
    if (i === historyIndex) {
      item.classList.add("current");
    } else if (i < historyIndex) {
      item.classList.add("played");
    }
    item.innerHTML = `<span class="material-icons" style="font-size:16px">${i === historyIndex ? 'play_arrow' : 'history'}</span> ${clip.file.split("/").pop()}`;
    item.onclick = () => {
      historyIndex = i;
      currentClip = clipHistory[i];
      updateNowPlaying();
      playClip(currentClip);
    };
    listEl.appendChild(item);
  });
  
  // Show upcoming clips in queue
  if (clipQueue.length > 0) {
    const separator = document.createElement("div");
    separator.className = "playlist-separator";
    separator.textContent = `Up next (${clipQueue.length} preloaded)`;
    listEl.appendChild(separator);
    
    clipQueue.forEach((clip) => {
      const item = document.createElement("div");
      item.className = "playlist-item upcoming";
      item.innerHTML = `<span class="material-icons" style="font-size:16px">schedule</span> ${clip.file.split("/").pop()}`;
      listEl.appendChild(item);
    });
  }
  
  // Scroll to current
  const currentEl = listEl.querySelector(".current");
  if (currentEl) {
    currentEl.scrollIntoView({ block: "center" });
  }
}

// -------------------------------------------------------------
//  Library / folder tree rendering
// -------------------------------------------------------------
async function loadTree() {
  const data = await (await fetch("/tree")).json();
  const root = document.getElementById("library");
  root.innerHTML = "";
  renderNodes(data, root);
}

function renderNodes(list, parent) {
  list.forEach(n => {
    const node = document.createElement("div");
    node.className = "node " + n.type;

    if (n.type === "dir") {
      const h = document.createElement("div");
      h.className = "dir-header";
      
      const expandBtn = document.createElement("button");
      expandBtn.className = "expand-btn";
      expandBtn.innerHTML = '<span class="material-icons">chevron_right</span>';
      
      const folderIcon = document.createElement("span");
      folderIcon.className = "material-icons folder-icon";
      folderIcon.textContent = "folder";
      
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = n.name;
      
      const playBtn = document.createElement("button");
      playBtn.className = "play-btn";
      playBtn.innerHTML = '<span class="material-icons">play_arrow</span>';
      
      h.onclick = () => {
        node.classList.toggle("open");
        folderIcon.textContent = node.classList.contains("open") ? "folder_open" : "folder";
      };
      
      playBtn.onclick = e => {
        e.stopPropagation();
        scopePath = n.path;
        clipQueue = [];
        updateCurrentFolder();
        hideStartScreen();
        nextClip();
      };
      
      h.append(expandBtn, folderIcon, name, playBtn);
      node.append(h);
      
      const kids = document.createElement("div");
      kids.className = "children";
      renderNodes(n.children, kids);
      node.append(kids);
    } else {
      const f = document.createElement("div");
      f.className = "filename";
      f.innerHTML = `<span class="material-icons">movie</span> ${n.name}`;
      f.onclick = () => {
        scopePath = n.path;
        currentVideo = n.path;
        clipQueue = [];
        updateCurrentFolder();
        hideStartScreen();
        nextClip();
      };
      node.append(f);
    }
    parent.append(node);
  });
}

// -------------------------------------------------------------
//  Start Screen
// -------------------------------------------------------------
function hideStartScreen() {
  const startScreen = document.getElementById("start-screen");
  if (startScreen) {
    startScreen.classList.add("hidden");
  }
  isPlaying = true;
}

function startPlayback() {
  scopePath = "";
  clipQueue = [];
  updateCurrentFolder();
  hideStartScreen();
  document.getElementById("sidebar").classList.remove("open");
  nextClip();
}

// -------------------------------------------------------------
//  INIT
// -------------------------------------------------------------
window.onload = () => {
  player = document.getElementById("player");
  preloader = document.getElementById("preloader");
  preloader.style.display = "none";

  // Start button
  document.getElementById("startBtn").onclick = startPlayback;

  // Control buttons
  document.getElementById("prevBtn").onclick = prevClip;
  document.getElementById("pauseBtn").onclick = togglePause;
  document.getElementById("nextBtn").onclick = nextClip;
  document.getElementById("fullBtn").onclick = fullVideo;
  document.getElementById("resetBtn").onclick = fullReset;
  document.getElementById("fullscreenBtn").onclick = toggleFullscreen;

  // Duration buttons
  document.querySelectorAll(".dur-btn").forEach(btn => {
    btn.onclick = () => setClipDuration(parseInt(btn.dataset.dur));
  });

  // Sidebar
  const sb = document.getElementById("sidebar");
  document.getElementById("menuBtn").onclick = () => sb.classList.toggle("open");
  document.getElementById("closeSidebar").onclick = () => sb.classList.remove("open");
  
  // Play root button in sidebar
  document.getElementById("playRootBtn").onclick = startPlayback;

  // Cache bar / playlist popup
  document.getElementById("cache-bar").onclick = togglePlaylistPopup;
  document.getElementById("closePlaylist").onclick = () => {
    document.getElementById("playlist-popup").classList.add("hidden");
  };

  // Start auto-hide for topbar
  startAutoHide();

  // Start session and load tree, but don't auto-play
  startSession();
  loadTree();
};

window.onbeforeunload = () => {
  endSession();
};
