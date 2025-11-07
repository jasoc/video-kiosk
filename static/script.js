let player, preloader;
let currentClip=null, currentVideo=null;
let scopeType="folder", scopePath="";
let lockMode="folderLoop";
let clipHistory=[], historyIndex=-1;
const videoDurations={};

const fmt=s=>`${Math.floor(s/60)}:${(s%60).toString().padStart(2,"0")}`;
const setStatus=t=>document.getElementById("status").textContent=t;

// -------------------------------------------------------------
//  Video CONTROL CORE
// -------------------------------------------------------------
async function nextClip(){
  let clip;

  if(lockMode==="clipHold" && currentClip){
    clip=currentClip;
  } else {
    const params=new URLSearchParams();
    if(scopePath) params.set("target",scopePath);
    clip=await (await fetch(`/random${params.toString()?`?${params.toString()}`:""}`)).json();
    if(clip.error){
      setStatus(clip.error);
      return;
    }
    if(typeof clip.dur==="number") videoDurations[clip.file]=clip.dur;
  }

  currentClip=clip;
  currentVideo=clip.file;
  clipHistory.splice(historyIndex+1);
  clipHistory.push(clip);
  historyIndex=clipHistory.length-1;
  playClip(clip);
}

// -------------------------------------------------------------
//  Playback logic with pre-buffer and robust seek
// -------------------------------------------------------------
function playClip(clip){
  clearTimeout(player.nextT);
  const sameFile = player.dataset.src === clip.file;

  if (!sameFile){
    player.src = `/video/${clip.file}`;
    player.dataset.src = clip.file;
  }

  const seekNow = () => {
    try { player.currentTime = clip.start; } catch(e) {}
    player.muted = false;
    player.play().catch(()=>{});
  };

  if (player.readyState < 1){
    player.addEventListener("loadedmetadata", seekNow, { once:true });
    player.load();
  } else {
    seekNow();
  }

  player.controls = (lockMode==="full");
  updateStatus();

  if(lockMode!=="full" && lockMode!=="clipHold" && clip.length>0){
    player.nextT=setTimeout(nextClip, clip.length*1000);
    preparePreload();
  }
}

// -------------------------------------------------------------
//  Pre-buffer next file (folder mode)
// -------------------------------------------------------------
async function preparePreload(){
  if(scopeType==="file") return;
  const params=new URLSearchParams();
  if(scopePath) params.set("target",scopePath);
  params.set("preview","1");
  const nxt=await (await fetch(`/random?${params.toString()}`)).json();
  if(nxt.error) return;
  videoDurations[nxt.file]=nxt.dur;
  preloader.src=`/video/${nxt.file}`;
  preloader.dataset.src=nxt.file;
  preloader.load();
}

// -------------------------------------------------------------
//  Mode & status helpers
// -------------------------------------------------------------
function updateStatus(){
  const fn=currentVideo?currentVideo.split("/").pop():"";
  if(lockMode==="clipHold")
    setStatus(`Holding clip in ${fn} (${fmt(currentClip.start)}→${fmt(currentClip.start+currentClip.length)})`);
  else if(scopeType==="file")
    setStatus(`Looping random clips in FILE: ${fn}`);
  else
    setStatus(`Looping random clips in FOLDER: ${scopePath||"root"}`);
}

function prevClip(){
  if(historyIndex>0){
    historyIndex--;
    const clip=clipHistory[historyIndex];
    currentClip=clip;
    playClip(clip);
  }
}
function nextRandom(){ nextClip(); }
function randSame(){
  if(currentVideo) scopePath=currentVideo;
  scopeType="file";
  lockMode="fileLoop";
  nextClip();
}
function holdClip(){ lockMode="clipHold"; updateStatus(); }
function fullVideo(){
  if(!currentVideo) return;
  lockMode="full";
  currentClip={file:currentVideo,start:0,length:9999};
  playClip(currentClip);
}
function fullReset(){ lockMode="folderLoop"; scopeType="folder"; nextClip(); }

// -------------------------------------------------------------
//  Video element safe reset (fix for stalled state after clicks)
// -------------------------------------------------------------
function safeResetVideoElement(){
  const fresh = player.cloneNode(false);
  fresh.id = "player";
  fresh.style.width = "100%";
  fresh.style.height = "100%";
  fresh.dataset.src = "";
  player.replaceWith(fresh);
  player = fresh;
}

// -------------------------------------------------------------
//  Library / folder tree rendering
// -------------------------------------------------------------
async function loadTree(){
  const data=await (await fetch("/tree")).json();
  const root=document.getElementById("library");
  root.innerHTML="";
  renderNodes(data,root);
}

function renderNodes(list,parent){
  list.forEach(n=>{
    const node=document.createElement("div");
    node.className="node "+n.type;

    if(n.type==="dir"){
      const h=document.createElement("div");h.className="dir-header";
      const tri=document.createElement("button");tri.textContent="▶";
      const name=document.createElement("span");name.textContent=n.name;
      const play=document.createElement("button");play.textContent="▶";
      h.onclick=()=>{node.classList.toggle("open");
        tri.textContent=node.classList.contains("open")?"▼":"▶";};
      play.onclick=e=>{
        e.stopPropagation();
        scopeType="folder";scopePath=n.path;lockMode="folderLoop";
        nextClip();
      };
      h.append(tri,name,play);node.append(h);
      const kids=document.createElement("div");kids.className="children";
      renderNodes(n.children,kids);node.append(kids);
    }else{
      const f=document.createElement("span");
      f.className="filename";f.textContent=n.name;
      f.onclick=()=>{
        // 🧩 Reset DOM <video> to clear stalled state
        safeResetVideoElement();

        scopeType="file";
        scopePath=n.path;
        currentVideo=n.path;
        lockMode="fileLoop";
        nextClip();
      };
      node.append(f);
    }
    parent.append(node);
  });
}

// -------------------------------------------------------------
//  INIT
// -------------------------------------------------------------
window.onload=()=>{
  player=document.getElementById("player");
  preloader=document.getElementById("preloader");
  preloader.style.display="none";

  document.getElementById("prevBtn").onclick=prevClip;
  document.getElementById("nextBtn").onclick=nextRandom;
  document.getElementById("randSameBtn").onclick=randSame;
  document.getElementById("loopClipBtn").onclick=holdClip;
  document.getElementById("fullBtn").onclick=fullVideo;
  document.getElementById("resetBtn").onclick=fullReset;

  const sb=document.getElementById("sidebar");
  document.getElementById("menuBtn").onclick=()=>sb.classList.toggle("open");
  document.getElementById("closeSidebar").onclick=()=>sb.classList.remove("open");

  loadTree();
  nextClip();
};