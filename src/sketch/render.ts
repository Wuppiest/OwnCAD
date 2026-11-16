// Builds Three.js objects (in sketch-local coordinates) for the sketch being edited.

import * as THREE from 'three';
import type { SketchConstraint, SketchCurve, SketchFeature, SketchPoint, Vec2 } from '../model/types';
import { add, arcAngles, dist, len, norm, P, scale, sub, tessellate, TAU } from './geom';
import { fmt } from '../model/expr';

export const COLORS = {
  under: 0x7dd3fc,
  full: 0xf1f5f9,
  construction: 0xa3a3a3,
  selected: 0xf97316,
  hover: 0xfde047,
  conflict: 0xef4444,
  ref: 0x8b5cf6,
  dim: 0x60a5fa,
  preview: 0x93c5fd,
  fill: 0x3b82f6,
};

export interface DimLayout {
  segments: Vec2[][];
  label: Vec2;
  text: string;
  measured: number;
}

/** Measures the current geometric value of a dimension (angles in degrees). */
export function measure(c: SketchConstraint, pts: Map<string, SketchPoint>, curves: Map<string, SketchCurve>): number {
  const r = c.refs;
  const pt = (id: string) => pts.get(id);
  switch (c.type) {
    case 'distance': {
      if (r.length === 1) {
        const l = curves.get(r[0]);
        if (l?.type !== 'line') return 0;
        return dist(P(pt(l.p1)!), P(pt(l.p2)!));
      }
      const l = curves.get(r[1]);
      if (l?.type === 'line') {
        const a = P(pt(l.p1)!), b = P(pt(l.p2)!), p = P(pt(r[0])!);
        const d = norm(sub(b, a));
        return Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]);
      }
      return dist(P(pt(r[0])!), P(pt(r[1])!));
    }
    case 'hdistance':
      return pt(r[1])!.x - pt(r[0])!.x;
    case 'vdistance':
      return pt(r[1])!.y - pt(r[0])!.y;
    case 'radius':
    case 'diameter': {
      const cv = curves.get(r[0]);
      const rad = cv && cv.type !== 'line' ? cv.r : 0;
      return c.type === 'diameter' ? rad * 2 : rad;
    }
    case 'angle': {
      const l1 = curves.get(r[0]), l2 = curves.get(r[1]);
      if (l1?.type !== 'line' || l2?.type !== 'line') return 0;
      const d = (l: typeof l1) => Math.atan2(pt(l.p2)!.y - pt(l.p1)!.y, pt(l.p2)!.x - pt(l.p1)!.x);
      let a = Math.abs(d(l2) - d(l1)) % TAU;
      if (a > Math.PI) a = TAU - a;
      return (a * 180) / Math.PI;
    }
    default:
      return 0;
  }
}

function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
  return [a1[0] + t * (a2[0] - a1[0]), a1[1] + t * (a2[1] - a1[1])];
}

/** Geometry (lines + label anchor) for drawing a dimension. */
export function dimensionLayout(c: SketchConstraint, pts: Map<string, SketchPoint>, curves: Map<string, SketchCurve>, valueText?: string): DimLayout | null {
  const r = c.refs;
  if (r.some((id) => !pts.has(id) && !curves.has(id))) return null;
  const off = c.offset ?? [0, 0];
  const m = measure(c, pts, curves);
  const txt = valueText ?? fmt(Math.abs(m), 2);
  const segs: Vec2[][] = [];
  switch (c.type) {
    case 'distance':
    case 'hdistance':
    case 'vdistance': {
      let a: Vec2, b: Vec2;
      if (r.length === 1) {
        const l = curves.get(r[0]) as any;
        a = P(pts.get(l.p1)!);
        b = P(pts.get(l.p2)!);
      } else if (curves.get(r[1])?.type === 'line') {
        const l = curves.get(r[1]) as any;
        const la = P(pts.get(l.p1)!), lb = P(pts.get(l.p2)!);
        a = P(pts.get(r[0])!);
        const d = norm(sub(lb, la));
        const t = (a[0] - la[0]) * d[0] + (a[1] - la[1]) * d[1];
        b = add(la, scale(d, t));
        segs.push([la, b]); // extension of the line to the foot point
      } else {
        a = P(pts.get(r[0])!);
        b = P(pts.get(r[1])!);
      }
      const mid = scale(add(a, b), 0.5);
      const label = add(mid, off);
      if (c.type === 'hdistance') {
        const y = label[1];
        segs.push([a, [a[0], y]], [b, [b[0], y]], [[a[0], y], [b[0], y]]);
        return { segments: segs, label: [label[0], y], text: txt, measured: m };
      }
      if (c.type === 'vdistance') {
        const x = label[0];
        segs.push([a, [x, a[1]]], [b, [x, b[1]]], [[x, a[1]], [x, b[1]]]);
        return { segments: segs, label: [x, label[1]], text: txt, measured: m };
      }
      const dir = len(sub(b, a)) > 1e-9 ? norm(sub(b, a)) : ([1, 0] as Vec2);
      const nrm: Vec2 = [-dir[1], dir[0]];
      const h = off[0] * nrm[0] + off[1] * nrm[1];
      const a2 = add(a, scale(nrm, h)), b2 = add(b, scale(nrm, h));
      segs.push([a, a2], [b, b2], [a2, b2]);
      return { segments: segs, label: add(mid, off), text: txt, measured: m };
    }
    case 'radius':
    case 'diameter': {
      const cv = curves.get(r[0]);
      if (!cv || cv.type === 'line') return null;
      const ctr = P(pts.get(cv.c)!);
      const defDir: Vec2 = len(off) > 1e-9 ? norm(off) : [Math.SQRT1_2, Math.SQRT1_2];
      const label = len(off) > 1e-9 ? add(ctr, off) : add(ctr, scale(defDir, cv.r * 1.4));
      const edge = add(ctr, scale(defDir, cv.r));
      if (c.type === 'diameter') segs.push([add(ctr, scale(defDir, -cv.r)), label]);
      else segs.push([ctr, label]);
      void edge;
      return { segments: segs, label, text: (c.type === 'diameter' ? '⌀' : 'R') + txt, measured: m };
    }
    case 'angle': {
      const l1 = curves.get(r[0]), l2 = curves.get(r[1]);
      if (l1?.type !== 'line' || l2?.type !== 'line') return null;
      const a1 = P(pts.get(l1.p1)!), a2 = P(pts.get(l1.p2)!), b1 = P(pts.get(l2.p1)!), b2 = P(pts.get(l2.p2)!);
      const x = lineIntersection(a1, a2, b1, b2) ?? scale(add(a1, b1), 0.5);
      const label = add(x, len(off) > 1e-9 ? off : scale(norm(add(norm(sub(a2, a1)), norm(sub(b2, b1)))), 12));
      const rad = Math.max(dist(label, x), 1);
      // short arc around the intersection from line1 direction to label direction
      const ang1 = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]);
      const ang2 = Math.atan2(b2[1] - b1[1], b2[0] - b1[0]);
      const arc: Vec2[] = [];
      let s = ang1, e = ang2;
      let sw = e - s;
      while (sw > Math.PI) sw -= TAU;
      while (sw < -Math.PI) sw += TAU;
      for (let i = 0; i <= 24; i++) {
        const t = s + (sw * i) / 24;
        arc.push([x[0] + rad * Math.cos(t), x[1] + rad * Math.sin(t)]);
      }
      segs.push(arc);
      return { segments: segs, label, text: txt + '°', measured: m };
    }
  }
  return null;
}

/** Where to draw a constraint badge for a given referenced entity. */
export function badgeAnchor(id: string, pts: Map<string, SketchPoint>, curves: Map<string, SketchCurve>, idx: number): Vec2 | null {
  const p = pts.get(id);
  if (p) return [p.x, p.y];
  const c = curves.get(id);
  if (!c) return null;
  if (c.type === 'line') {
    const a = P(pts.get(c.p1)!), b = P(pts.get(c.p2)!);
    const t = 0.5 + (idx % 3) * 0.12 - 0.12;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const ctr = pts.get(c.c)!;
  if (c.type === 'circle') return [ctr.x + c.r * Math.cos(1 + idx * 0.4), ctr.y + c.r * Math.sin(1 + idx * 0.4)];
  const { a0, sweep } = arcAngles(c, pts);
  const a = a0 + sweep / 2;
  return [ctr.x + c.r * Math.cos(a), ctr.y + c.r * Math.sin(a)];
}

export const BADGE: Partial<Record<SketchConstraint['type'], string>> = {
  coincident: '●',
  pointOnCurve: '◦',
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '=',
  tangent: 'T',
  midpoint: 'M',
  symmetric: 'S',
  concentric: '◎',
  fix: '⚓',
};

export function polyLine(points: Vec2[], color: number, opts: { dashed?: boolean; z?: number; opacity?: number } = {}) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p[0], p[1], opts.z ?? 0)));
  const mat = opts.dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 });
  const l = new THREE.Line(geo, mat);
  if (opts.dashed) l.computeLineDistances();
  l.renderOrder = 20;
  return l;
}

export function curvePoly(c: SketchCurve, pts: Map<string, SketchPoint>) {
  return tessellate(c, pts);
}

let dotTexture: THREE.Texture | null = null;
function dot() {
  if (dotTexture) return dotTexture;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(16, 16, 12, 0, TAU);
  g.fill();
  dotTexture = new THREE.CanvasTexture(cv);
  return dotTexture;
}

export function pointsObject(items: { p: Vec2; color: number }[], size = 8) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(items.flatMap((i) => [i.p[0], i.p[1], 0]), 3));
  const col = new THREE.Color();
  geo.setAttribute('color', new THREE.Float32BufferAttribute(items.flatMap((i) => col.setHex(i.color).toArray()), 3));
  const mat = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, map: dot(), alphaTest: 0.5, depthTest: false, transparent: true });
  const o = new THREE.Points(geo, mat);
  o.renderOrder = 30;
  return o;
}

export type { SketchFeature };
