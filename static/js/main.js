"use strict";

// ---------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------
window.addEventListener("load", () => {
  try { mosaicAudio = !!localStorage.getItem("kiosk.audio"); } catch (e) {}
  initGrid();
  initEditor();
  initDrawerGestures();
  // Themes that were merged or removed: move this device to their heir.
  const heir = { atelier: "lusso", jetset: "lusso", festa: "camera", boudoir: "camera" };
  const saved = document.documentElement.dataset.theme;
  if (heir[saved]) applyTheme(heir[saved]);
  else if (saved && currentTheme() === "camera") applyTheme("camera");
  document.addEventListener("input", e => { if (e.target.type === "range") paintRange(e.target); });
  syncGlass();
  updateAudioBtn();
  updateUndoBtn();
  loadTree();
  migrateLocal().then(refreshMosaics);

  const sidebar = document.getElementById("sidebar");
  const openDrawer = tab => {
    showTab(tab);
    sidebar.classList.add("open");
    refreshMosaics();
  };
  document.getElementById("homePlay").addEventListener("click", () => playScope(""));
  document.getElementById("homeMosaic").addEventListener("click", () => randomMosaic(""));
  document.getElementById("homeLib").addEventListener("click", () => openDrawer("lib"));
  document.getElementById("homeSmart").addEventListener("click", () => openDrawer("smart"));
  document.getElementById("homeFull").addEventListener("click", toggleFullscreen);
  // The drawer sits under the home: opening it puts the home away (the
  // empty canvas is where things get dropped), closing it with nothing
  // playing brings the home back. Not mid-drag (a phone closes the
  // drawer to make room for the drop).
  new MutationObserver(() => {
    if (sidebar.classList.contains("open")) hideStart();
    else if (!tiles.size && !Smart.active && !document.querySelector(".lib-card.dragging")) showStart();
  }).observe(sidebar, { attributes: true, attributeFilter: ["class"] });
  renderThemeBar();
  showStart();
  document.getElementById("menuBtn").addEventListener("click", () => {
    if (document.getElementById("sidebar").classList.toggle("open")) refreshMosaics();
  });
  document.getElementById("closeSidebar").addEventListener("click", closeSidebar);
  document.getElementById("themeBtn").addEventListener("click", () => {
    renderThemeBar();
    document.getElementById("themeBar").classList.toggle("hidden");
  });
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("nextBtn").addEventListener("click", nextAll);
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("audioBtn").addEventListener("click", toggleAudio);
  document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.getElementById("layoutBtn").addEventListener("click", e => {
    e.stopPropagation();
    toggleLayoutPop();
  });
  document.getElementById("saveMosaicBtn").addEventListener("click", saveMosaic);
  for (const tab of document.querySelectorAll(".sb-tab"))
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  document.getElementById("libPlay").addEventListener("click", () => playScope(navPath));
  document.getElementById("libMosaic").addEventListener("click", () => randomMosaic(navPath));
  document.getElementById("promptCancel").addEventListener("click", closePrompt);
  document.getElementById("promptOk").addEventListener("click", submitPrompt);
  document.getElementById("promptInput").addEventListener("keydown", e => {
    if (e.key === "Enter") submitPrompt();
    if (e.key === "Escape") closePrompt();
  });
  document.getElementById("prompt-modal").addEventListener("click", e => {
    if (e.target.id === "prompt-modal") closePrompt();
  });

  // Close the layout popover on any outside press.
  document.addEventListener("pointerdown", e => {
    const pop = document.getElementById("layout-pop");
    if (!pop.classList.contains("hidden") &&
        !pop.contains(e.target) &&
        !document.getElementById("layoutBtn").contains(e.target))
      pop.classList.add("hidden");
  });

  document.addEventListener("pointermove", pokeTopbar);
  document.addEventListener("pointerdown", pokeTopbar);
  pokeTopbar();
});
