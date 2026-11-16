// Closed-region detection for sketches.
// Builds a planar graph from all non-construction curves and walks its faces.
// Every bounded face (CCW) becomes a loop; full circles are loops on their own.
// The loops are later combined with the EvenOdd fill rule, so nested loops become holes.

import type { SketchCurve, SketchFeature, Vec2 } from '../model/types';
import { pointMap, tessellate } from './geom';

interface HalfEdge {
  from: string;
  to: string;
  pts: Vec2[]; // polyline from -> to
  angle: number; // outgoing direction at "from"
  used: boolean;
}

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

export function findProfiles(sketch: SketchFeature): ProfileResult {
  const pts = pointMap(sketch);
  const loops: Vec2[][] = [];
  const out: HalfEdge[] = [];
  const byVertex = new Map<string, HalfEdge[]>();
  const usedInLoop = new Set<string>();
  const edgeCurve = new Map<HalfEdge, string>();

  const curves = sketch.curves.filter((c) => !c.construction);
  for (const c of curves) {
    if (c.type === 'circle') {
      if (c.r > 1e-9) {
        const poly = tessellate(c, pts);
        poly.pop(); // closing duplicate
        loops.push(poly);
        usedInLoop.add(c.id);
      }
      continue;
    }
    const [a, b] = c.type === 'line' ? [c.p1, c.p2] : [c.s, c.e];
    if (a === b) continue;
    const poly = tessellate(c as SketchCurve, pts);
    const rev = [...poly].reverse();
    const mk = (from: string, to: string, p: Vec2[]): HalfEdge => ({
      from, to, pts: p, used: false,
      angle: Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]),
    });
    const h1 = mk(a, b, poly), h2 = mk(b, a, rev);
    out.push(h1, h2);
    edgeCurve.set(h1, c.id);
    edgeCurve.set(h2, c.id);
    for (const h of [h1, h2]) {
      if (!byVertex.has(h.from)) byVertex.set(h.from, []);
      byVertex.get(h.from)!.push(h);
    }
  }
  for (const list of byVertex.values()) list.sort((x, y) => x.angle - y.angle);

  // Twin lookup: the reverse half-edge shares the same polyline object reversed.
  const twin = new Map<HalfEdge, HalfEdge>();
  for (let i = 0; i < out.length; i += 2) {
    twin.set(out[i], out[i + 1]);
    twin.set(out[i + 1], out[i]);
  }

  // Face walk: after arriving at v via edge e, take the next edge clockwise from twin(e).
  for (const start of out) {
    if (start.used) continue;
    const poly: Vec2[] = [];
    const curveIds: string[] = [];
    let e = start;
    let guard = 0;
    let closed = false;
    while (!e.used && guard++ < 10000) {
      e.used = true;
      poly.push(...e.pts.slice(0, -1));
      curveIds.push(edgeCurve.get(e)!);
      const list = byVertex.get(e.to)!;
      const t = twin.get(e)!;
      const idx = list.indexOf(t);
      // previous in CCW-sorted order = next clockwise
      const next = list[(idx - 1 + list.length) % list.length];
      e = next;
      if (e === start) { closed = true; break; }
    }
    if (!closed || poly.length < 3) continue;
    const area = signedArea(poly);
    if (area > 1e-9) {
      loops.push(poly);
      for (const id of curveIds) usedInLoop.add(id);
    }
  }

  const openCurveIds = curves.filter((c) => !usedInLoop.has(c.id)).map((c) => c.id);
  return { loops, openCurveIds };
}
