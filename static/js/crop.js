"use strict";

// ---------------------------------------------------------------------
//  Smart crop detection
//
//  Plenty of "horizontal" videos are really a vertical clip with black
//  bars baked into the frame. One 64px-wide sample of a frame is enough
//  to find the real content box, which "smart" zoom then blows up to
//  fill the tile. Cheap (a few ms), same-origin so the canvas is clean,
//  and cached per file. It can be fooled by a very dark frame, which is
//  why the button cycles: one more tap and you are back to fill/fit.
// ---------------------------------------------------------------------
const cropCache = new Map();   // file -> {x, y, w, h} in 0..1 video coords
let probeCanvas = null;

function detectCrop(el, file) {
  if (cropCache.has(file)) return cropCache.get(file);
  const vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return null;
  const W = 64, H = Math.max(8, Math.round(W * vh / vw));
  probeCanvas ||= document.createElement("canvas");
  probeCanvas.width = W;
  probeCanvas.height = H;
  const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
  let px;
  try {
    ctx.drawImage(el, 0, 0, W, H);
    px = ctx.getImageData(0, 0, W, H).data;
  } catch (e) {
    return null;
  }

  const LIT = 26 * 3;          // r+g+b above this is not a black bar
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i] + px[i + 1] + px[i + 2] < LIT) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  // A (nearly) black frame says nothing: don't cache, try again later.
  if (x1 < 0 || w * h < W * H * 0.12) return null;
  const box = w > W * 0.96 && h > H * 0.96
    ? { x: 0, y: 0, w: 1, h: 1 }
    : { x: x0 / W, y: y0 / H, w: w / W, h: h / H };
  if (cropCache.size > 400) cropCache.clear();
  cropCache.set(file, box);
  return box;
}
