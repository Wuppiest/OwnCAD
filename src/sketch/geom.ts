// Pure 2D helpers for sketch geometry.

import type { Frame, OriginPlane, SketchArc, SketchCurve, SketchFeature, SketchPoint, Vec2, Vec3 } from '../model/types';

export const ORIGIN_ID = 'origin';
export const TAU = Math.PI * 2;

export function pointMap(s: SketchFeature): Map<string, SketchPoint> {
  return new Map(s.points.map((p) => [p.id, p]));
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
export const P = (p: SketchPoint): Vec2 => [p.x, p.y];

export function normAngle(a: number) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

/** Start/end angle of an arc and its CCW sweep (0..2π). */
export function arcAngles(arc: SketchArc, pts: Map<string, SketchPoint>) {
  const c = pts.get(arc.c)!, s = pts.get(arc.s)!, e = pts.get(arc.e)!;
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  let sweep = normAngle(a1 - a0);
  if (sweep < 1e-9) sweep = TAU;
  return { a0, a1, sweep, c };
}

export function segmentsFor(radius: number, sweep: number) {
  // ~ 2° per segment, at least 0.2mm chord, clamped
  const byAngle = Math.ceil(sweep / (Math.PI / 90));
  const byLen = Math.ceil((radius * sweep) / 0.2);
  return Math.max(6, Math.min(byAngle, byLen, 360));
}

/** Polyline of a curve in sketch coordinates. */
export function tessellate(curve: SketchCurve, pts: Map<string, SketchPoint>): Vec2[] {
  if (curve.type === 'line') {
    const a = pts.get(curve.p1)!, b = pts.get(curve.p2)!;
    return [[a.x, a.y], [b.x, b.y]];
  }
  if (curve.type === 'circle') {
    const c = pts.get(curve.c)!;
    const n = segmentsFor(curve.r, TAU);
    const out: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      out.push([c.x + curve.r * Math.cos(a), c.y + curve.r * Math.sin(a)]);
    }
    return out;
  }
  const { a0, sweep, c } = arcAngles(curve, pts);
  const s = pts.get(curve.s)!, e = pts.get(curve.e)!;
  const n = segmentsFor(curve.r, sweep);
  const out: Vec2[] = [[s.x, s.y]];
  for (let i = 1; i < n; i++) {
    const a = a0 + (i / n) * sweep;
    out.push([c.x + curve.r * Math.cos(a), c.y + curve.r * Math.sin(a)]);
  }
  out.push([e.x, e.y]);
  return out;
}

/** Closest point on segment ab to p, with parameter t. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  const pt: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { pt, t, d: dist(p, pt) };
}

/** Distance from a point to a curve (for picking). */
export function distanceToCurve(p: Vec2, curve: SketchCurve, pts: Map<string, SketchPoint>): number {
  if (curve.type === 'line') {
    return closestOnSegment(p, P(pts.get(curve.p1)!), P(pts.get(curve.p2)!)).d;
  }
  const c = pts.get(curve.c)!;
  const dc = Math.abs(dist(p, [c.x, c.y]) - curve.r);
  if (curve.type === 'circle') return dc;
  const { a0, sweep } = arcAngles(curve, pts);
  const a = normAngle(Math.atan2(p[1] - c.y, p[0] - c.x) - a0);
  if (a <= sweep) return dc;
  const s = pts.get(curve.s)!, e = pts.get(curve.e)!;
  return Math.min(dist(p, [s.x, s.y]), dist(p, [e.x, e.y]));
}

/** Intersections between two curves (used for snapping). */
export function intersections(a: SketchCurve, b: SketchCurve, pts: Map<string, SketchPoint>): Vec2[] {
  const pa = tessellate(a, pts), pb = tessellate(b, pts);
  const out: Vec2[] = [];
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      const r = segIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1]);
      if (r) out.push(r);
    }
  }
  return out;
}

export function segIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

// ------------------------------------------------------------ frames

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

export const ORIGIN_FRAMES: Record<OriginPlane, Frame> = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
};

/** Build a frame for an arbitrary plane given a point and normal. */
export function frameFromPlane(point: Vec3, normal: Vec3): Frame {
  const z = v3.norm(normal);
  // project world origin onto the plane for a stable origin
  const d = v3.dot(point, z);
  const origin = v3.scale(z, d);
  // pick a reference axis not parallel to the normal
  let ref: Vec3 = Math.abs(z[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  if (Math.abs(z[2]) > 0.9) {
    // horizontal faces: keep world X as sketch X (flip if facing down)
    ref = [1, 0, 0];
    const x = v3.norm(v3.sub(ref, v3.scale(z, v3.dot(ref, z))));
    return { origin, x, y: v3.cross(z, x), z };
  }
  // vertical faces: sketch Y = world Z
  const y = v3.norm(v3.sub(ref, v3.scale(z, v3.dot(ref, z))));
  const x = v3.cross(y, z);
  return { origin, x, y, z };
}

export function offsetFrame(f: Frame, offset: number): Frame {
  return { ...f, origin: v3.add(f.origin, v3.scale(f.z, offset)) };
}

/** Column-major 4x4 matrix of a frame (local -> world). */
export function frameMatrix(f: Frame): number[] {
  return [...f.x, 0, ...f.y, 0, ...f.z, 0, ...f.origin, 1];
}

export function toWorld(f: Frame, p: Vec2, h = 0): Vec3 {
  return [
    f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * h,
    f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * h,
    f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * h,
  ];
}

export function toLocal(f: Frame, w: Vec3): Vec3 {
  const d = v3.sub(w, f.origin);
  return [v3.dot(d, f.x), v3.dot(d, f.y), v3.dot(d, f.z)];
}
