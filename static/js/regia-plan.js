// =====================================================================
//  Regia — the layout planner. A layout is a tree of splits:
//  {cell} | {dir, ratio, a, b}, "v" = side by side, "h" = stacked.
//
//  The director never places cells by a local rule: it builds candidate
//  trees (split this leaf or that one, either way, remove this cell or
//  that one), lets optimize() tune every split's direction and ratio,
//  and keeps the candidate with the lowest cost(). cost() is where the
//  taste lives, in plain numbers.
//
//  Pure arithmetic on the stage's size (attach()): no video, no DOM. A
//  leaf's cell is read for cell.rect (where it is now) and
//  cell.clip.aspect / cell.pending (the shape of what it plays).
// =====================================================================

"use strict";

const Plan = (() => {
  const RATIOS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
  const HIGHLIGHT_SHARE = 0.4;   // a cell this much of the stage stands out...
  const HIGHLIGHT_REL = 1.5;     // ...and so does one 1.5× the average cell

  const MIN_CELL_PX = 140;
  let stage = null;
  const stageSize = () => ({ W: stage?.clientWidth || innerWidth, H: stage?.clientHeight || innerHeight });

  const fitCost = (a, b) => Math.abs(Math.log(a / b));
  const orient = a => a > 1.15 ? "h" : a < 0.87 ? "v" : "s";
  // A vertical clip in a horizontal frame, or the other way round.
  const clash = (a, b) => {
    const x = orient(a), y = orient(b);
    return x !== "s" && y !== "s" && x !== y;
  };

  function standsOut(r, n) {
    const { W, H } = stageSize(), share = (r.w * r.h) / (W * H);
    return share >= HIGHLIGHT_SHARE || share * n >= HIGHLIGHT_REL;
  }

  const leavesOf = (n, out = []) => {
    if (n.cell) out.push(n); else { leavesOf(n.a, out); leavesOf(n.b, out); }
    return out;
  };
  const splitsOf = (n, out = []) => {
    if (!n.cell) { out.push(n); splitsOf(n.a, out); splitsOf(n.b, out); }
    return out;
  };
  const clone = n => n.cell ? { cell: n.cell }
    : { dir: n.dir, ratio: n.ratio, a: clone(n.a), b: clone(n.b) };

  // Leaves of `tree` with their rect on the stage.
  function rects(tree) {
    const { W, H } = stageSize(), out = [];
    const go = (n, x, y, w, h) => {
      if (n.cell) return out.push({ cell: n.cell, r: { x, y, w, h } });
      if (n.dir === "v") {
        const wa = w * n.ratio;
        go(n.a, x, y, wa, h); go(n.b, x + wa, y, w - wa, h);
      } else {
        const ha = h * n.ratio;
        go(n.a, x, y, w, ha); go(n.b, x, y + ha, w, h - ha);
      }
    };
    if (tree) go(tree, 0, 0, W, H);
    return out;
  }

  // How bad a layout is. Each term is one thing that looks wrong.
  function cost(tree) {
    const { W, H } = stageSize(), leaves = rects(tree), n = leaves.length;
    // The stage itself may be wide (a long tablet): a cell may be as wide
    // as the stage, not wider.
    const maxA = Math.max(1.9, W / H + 0.05), minA = 0.45;
    const minSide = Math.max(MIN_CELL_PX, H * 0.2);
    let c = 0;
    for (const { cell, r } of leaves) {
      const a = r.w / r.h, share = (r.w * r.h) / (W * H), rel = share * n;
      // Long strips and thin columns.
      if (a > maxA) c += 1 + 4 * Math.log(a / maxA);
      if (a < minA) c += 1 + 4 * Math.log(minA / a);
      // Crumbs: a cell much smaller than the average, or too small to read.
      if (rel < 0.45) c += 0.5 + 4 * (0.45 - rel);
      const side = Math.min(r.w, r.h);
      if (side < minSide) c += 2 + 6 * (1 - side / minSide);
      // The clip against its frame: matters more the bigger the frame,
      // and a crossed orientation in a cell that stands out is a no.
      const ca = cell.clip?.aspect ?? cell.pending ?? 16 / 9;
      c += fitCost(a, ca) * (0.3 + rel);
      if (clash(a, ca) && standsOut(r, n)) c += 6;
      // Continuity: a cell on screen shouldn't jump for a small gain.
      const o = cell.rect;
      if (o) c += 0.8 * (Math.abs(r.x - o.x) + Math.abs(r.y - o.y) +
                         Math.abs(r.w - o.w) + Math.abs(r.h - o.h)) / (W + H);
    }
    return c;
  }

  // Local search: try every direction and ratio of every split, keep what
  // lowers the cost, until a pass changes nothing. Six cells at most make
  // this a few hundred evaluations of cost(): nothing.
  function optimize(tree) {
    let best = cost(tree);
    for (let pass = 0; pass < 4; pass++) {
      let better = false;
      for (const s of splitsOf(tree)) {
        let keep = [s.dir, s.ratio];
        for (const dir of ["v", "h"]) {
          for (const ratio of RATIOS) {
            s.dir = dir;
            s.ratio = ratio;
            const c = cost(tree);
            if (c < best - 1e-6) { best = c; keep = [dir, ratio]; better = true; }
          }
        }
        [s.dir, s.ratio] = keep;
      }
      if (!better) break;
    }
    return best;
  }

  // Every tree with `cell` added: split any leaf, either way, either side.
  function withCell(tree, cell) {
    if (!tree) return [{ cell }];
    const out = [], count = leavesOf(tree).length;
    for (let k = 0; k < count; k++) {
      for (const dir of ["v", "h"]) {
        for (const first of [true, false]) {
          const t = clone(tree), leaf = leavesOf(t)[k];
          const old = { cell: leaf.cell }, fresh = { cell };
          delete leaf.cell;
          Object.assign(leaf, { dir, ratio: 0.5, a: first ? fresh : old, b: first ? old : fresh });
          out.push(t);
        }
      }
    }
    return out;
  }

  // `tree` without `cell`: its sibling takes the parent's space.
  function without(tree, cell) {
    if (tree.cell) return tree.cell === cell ? null : tree;
    const a = without(tree.a, cell), b = without(tree.b, cell);
    if (!a) return b;
    if (!b) return a;
    tree.a = a;
    tree.b = b;
    return tree;
  }

  // Optimise every candidate, return the cheapest {tree, cost}.
  function cheapest(trees) {
    let best = null;
    for (const t of trees) {
      const c = optimize(t);
      if (!best || c < best.cost) best = { tree: t, cost: c };
    }
    return best;
  }

  return {
    attach(el) { stage = el; },
    fitCost, clash, standsOut, leavesOf, splitsOf, clone, rects, cost, optimize,
    withCell, without, cheapest,
  };
})();
