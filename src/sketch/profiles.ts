// Closed-region detection for sketches.
// All non-construction curves are tessellated, split at every intersection / touching point
// and merged into a planar graph. Walking the faces of that graph yields every bounded
// region (CCW loops) — lines that end on another line or cross it split regions as expected.
// The loops are later combined with the EvenOdd fill rule, so nested loops become holes.

import type { SketchFeature, Vec2 } from '../model/types';
import { pointMap, tessellate } from './geom';

function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export interface ProfileResult {
  loops: Vec2[][];
  /** Curves that are open (not part of any closed region). */
  openCurveIds: string[];
}

interface Seg {
  a: Vec2;
  b: Vec2;
  curve: string;
  splits: number[]; // params in [0,1]
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const EPS = 1e-7;

export function findProfiles(sketch: SketchFeature): ProfileResult {
  const pts = pointMap(sketch);
  const curves = sketch.curves.filter((c) => !c.construction);

  // 1. tessellate into straight segments
  const segs: Seg[] = [];
  for (const c of curves) {
    if (c.type === 'circle' && c.r <= 1e-9) continue;
    const poly = tessellate(c, pts);
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      segs.push({
        a, b, curve: c.id, splits: [0, 1],
        minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]),
      });
    }
  }

  // 2. split segments at intersections and touching endpoints (sweep over x)
  const order = segs.map((_, i) => i).sort((i, j) => segs[i].minX - segs[j].minX);
  const paramOn = (s: Seg, p: Vec2): number | null => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const L2 = dx * dx + dy * dy;
    const t = ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2;
    if (t < -1e-9 || t > 1 + 1e-9) return null;
    const cx = s.a[0] + dx * t - p[0], cy = s.a[1] + dy * t - p[1];
    return cx * cx + cy * cy < EPS * EPS * 100 ? Math.min(1, Math.max(0, t)) : null;
  };
  for (let oi = 0; oi < order.length; oi++) {
    const s = segs[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const r = segs[order[oj]];
      if (r.minX > s.maxX + EPS) break;
      if (r.minY > s.maxY + EPS || s.minY > r.maxY + EPS) continue;
      // proper crossing
      const d = (s.b[0] - s.a[0]) * (r.b[1] - r.a[1]) - (s.b[1] - s.a[1]) * (r.b[0] - r.a[0]);
      if (Math.abs(d) > 1e-14) {
        const t = ((r.a[0] - s.a[0]) * (r.b[1] - r.a[1]) - (r.a[1] - s.a[1]) * (r.b[0] - r.a[0])) / d;
        const u = ((r.a[0] - s.a[0]) * (s.b[1] - s.a[1]) - (r.a[1] - s.a[1]) * (s.b[0] - s.a[0])) / d;
        if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) {
          s.splits.push(Math.min(1, Math.max(0, t)));
          r.splits.push(Math.min(1, Math.max(0, u)));
        }
      }
      // endpoints lying on the other segment (T-junctions, collinear overlaps)
      for (const p of [r.a, r.b]) {
        const t = paramOn(s, p);
        if (t !== null) s.splits.push(t);
      }
      for (const p of [s.a, s.b]) {
        const t = paramOn(r, p);
        if (t !== null) r.splits.push(t);
      }
    }
  }

  // 3. build the graph with merged vertices
  const CELL = 1e-5;
  const verts: Vec2[] = [];
  const hash = new Map<string, number[]>();
  const vertex = (p: Vec2): number => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const v of hash.get(`${cx + i},${cy + j}`) ?? [])
          if (Math.hypot(verts[v][0] - p[0], verts[v][1] - p[1]) < 1e-6) return v;
    verts.push(p);
    const k = `${cx},${cy}`;
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k)!.push(verts.length - 1);
    return verts.length - 1;
  };

  interface HalfEdge { from: number; to: number; angle: number; used: boolean; curve: string; twin?: HalfEdge }
  const edges: HalfEdge[] = [];
  const out = new Map<number, HalfEdge[]>();
  const seen = new Set<string>();
  for (const s of segs) {
    const ts = [...new Set(s.splits.map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    let prev = vertex(s.a);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k];
      const p: Vec2 = t >= 1 ? s.b : [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
      const v = vertex(p);
      if (v !== prev) {
        const key = prev < v ? `${prev}-${v}` : `${v}-${prev}`;
        if (!seen.has(key)) {
          seen.add(key);
          const A = verts[prev], B = verts[v];
          const h1: HalfEdge = { from: prev, to: v, angle: Math.atan2(B[1] - A[1], B[0] - A[0]), used: false, curve: s.curve };
          const h2: HalfEdge = { from: v, to: prev, angle: Math.atan2(A[1] - B[1], A[0] - B[0]), used: false, curve: s.curve };
          h1.twin = h2;
          h2.twin = h1;
          edges.push(h1, h2);
          for (const h of [h1, h2]) {
            if (!out.has(h.from)) out.set(h.from, []);
            out.get(h.from)!.push(h);
          }
        }
      }
      prev = v;
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.angle - y.angle);

  // 4. face walk: after arriving at v via e, continue with the next edge clockwise from twin(e)
  const loops: Vec2[][] = [];
  const usedInLoop = new Set<string>();
  for (const start of edges) {
    if (start.used) continue;
    const poly: Vec2[] = [];
    const cids = new Set<string>();
    let e = start;
    let guard = 0;
    let closed = false;
    while (!e.used && guard++ < 200000) {
      e.used = true;
      poly.push(verts[e.from]);
      cids.add(e.curve);
      const list = out.get(e.to)!;
      const idx = list.indexOf(e.twin!);
      e = list[(idx - 1 + list.length) % list.length];
      if (e === start) {
        closed = true;
        break;
      }
    }
    if (!closed || poly.length < 3) continue;
    if (signedArea(poly) > 1e-8) {
      loops.push(poly);
      cids.forEach((c) => usedInLoop.add(c));
    }
  }

  const openCurveIds = curves.filter((c) => !usedInLoop.has(c.id)).map((c) => c.id);
  return { loops, openCurveIds };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Region {
  /** Outer loop followed by its immediate holes. */
  polys: Vec2[][];
  area: number;
  /** A point inside the region (for labels). */
  label: Vec2;
}

/**
 * Splits the sketch into selectable regions: each closed loop minus the loops
 * directly nested inside it. Region order is stable for a given sketch.
 */
export function findRegions(sketch: SketchFeature): Region[] {
  const { loops } = findProfiles(sketch);
  const areas = loops.map((l) => Math.abs(signedArea(l)));
  const inside = (j: number, i: number) => i !== j && areas[j] < areas[i] && loops[j].every((p) => pointInPolygon(p, loops[i]) || onBoundary(p, loops[i])) && pointInPolygon(interiorPoint(loops[j], []), loops[i]);
  const parentOf = loops.map((_, j) => {
    let best = -1;
    loops.forEach((_, i) => {
      if (inside(j, i) && (best < 0 || areas[i] < areas[best])) best = i;
    });
    return best;
  });
  return loops.map((outer, i) => {
    const holes = loops.filter((_, j) => parentOf[j] === i);
    const area = areas[i] - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    return { polys: [outer, ...holes], area, label: interiorPoint(outer, holes) };
  });
}

function onBoundary(p: Vec2, poly: Vec2[]) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (Math.abs(cross) / len < 1e-6 && Math.min(a[0], b[0]) - 1e-6 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-6 && Math.min(a[1], b[1]) - 1e-6 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-6) return true;
  }
  return false;
}

/** Finds a point inside outer but outside all holes (scanline through the middle). */
function interiorPoint(outer: Vec2[], holes: Vec2[][]): Vec2 {
  const ys = outer.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95]) {
    const y = y0 + (y1 - y0) * f;
    const xs: number[] = [];
    for (const poly of [outer, ...holes])
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((p, q) => p - q);
    let best: Vec2 | null = null, bw = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > bw) {
        bw = xs[i + 1] - xs[i];
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
    if (best) return best;
  }
  return outer[0];
}
