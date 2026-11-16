// Rebuilds all solid bodies from the feature history.

import type { CrossSection, Manifold, Vec2 as MVec2 } from 'manifold-3d';
import type { BodyOp, CadDocument, Feature, Frame, SketchFeature, Vec2, Vec3 } from '../model/types';
import { ParamScope } from '../model/expr';
import { kernel } from './manifold';
import { findProfiles, findRegions } from '../sketch/profiles';
import { solveSketch, type SolveResult } from '../sketch/solver';
import { frameMatrix, offsetFrame, ORIGIN_FRAMES, pointMap } from '../sketch/geom';

export interface BodyMesh {
  id: string;
  name: string;
  featureId: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  faceIds: Uint32Array;
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3 };
  triangles: number;
}

export interface RegenResult {
  bodies: BodyMesh[];
  errors: Map<string, string>;
  warnings: Map<string, string>;
  frames: Map<string, Frame>;
  solves: Map<string, SolveResult>;
  scope: ParamScope;
  /** Body ids existing after each feature (for target pickers). */
  bodiesAfter: Map<string, { id: string; name: string }[]>;
  timeMs: number;
}

export function sketchFrame(s: SketchFeature, scope: ParamScope): Frame {
  const off = scope.tryEval(s.plane.offset || '0').value ?? 0;
  const base = s.plane.kind === 'origin' ? ORIGIN_FRAMES[s.plane.plane] : s.plane.frame;
  return offsetFrame(base, off);
}

type M4 = number[];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

const AXES: Record<'X' | 'Y' | 'Z', Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function regenerate(doc: CadDocument, opts: { skipSolve?: string } = {}): RegenResult {
  const t0 = performance.now();
  const wasm = kernel();
  const { Manifold, CrossSection } = wasm;
  const scope = new ParamScope(doc.params);
  const errors = new Map<string, string>();
  const warnings = new Map<string, string>();
  const frames = new Map<string, Frame>();
  const solves = new Map<string, SolveResult>();
  const bodiesAfter = new Map<string, { id: string; name: string }[]>();
  const garbage: { delete(): void }[] = [];
  const T = <X extends { delete(): void }>(x: X): X => {
    garbage.push(x);
    return x;
  };

  const bodies = new Map<string, { m: Manifold; name: string; featureId: string }>();
  let bodyCounter = 0;
  const newBody = (id: string, m: Manifold, featureId: string) => {
    bodies.set(id, { m, name: `Body${++bodyCounter}`, featureId });
  };
  const lastBody = () => [...bodies.keys()].pop();

  const E = (src: string, what: string) => {
    const r = scope.tryEval(src);
    if (r.error !== undefined) throw new Error(`${what}: ${r.error}`);
    return r.value!;
  };

  const applyOp = (f: Feature, op: BodyOp, target: string, tool: Manifold) => {
    if (tool.isEmpty()) throw new Error('Feature produced an empty solid');
    if (op === 'new' || (bodies.size === 0 && op === 'join')) {
      newBody(f.id, tool, f.id);
      return;
    }
    if (op === 'cut') {
      if (bodies.size === 0) throw new Error('There is no body to cut');
      const ids = target === 'auto' ? touching(tool) : [target];
      if (!ids.length) throw new Error('The cut does not intersect any body');
      for (const id of ids) {
        const b = bodies.get(id);
        if (!b) throw new Error(`Target body not found`);
        b.m = T(b.m.subtract(tool));
      }
      return;
    }
    if (target !== 'auto') {
      const b = bodies.get(target);
      if (!b) throw new Error('Target body not found');
      b.m = T(op === 'join' ? b.m.add(tool) : b.m.intersect(tool));
      return;
    }
    // automatic: operate on the bodies the tool touches
    const hits = touching(tool);
    if (op === 'join') {
      if (!hits.length) return newBody(f.id, tool, f.id);
      const first = bodies.get(hits[0])!;
      first.m = T(Manifold.union([first.m, tool, ...hits.slice(1).map((h) => bodies.get(h)!.m)]));
      for (const h of hits.slice(1)) bodies.delete(h);
      return;
    }
    if (!hits.length) throw new Error('The feature does not intersect any body');
    for (const h of hits) {
      const b = bodies.get(h)!;
      b.m = T(b.m.intersect(tool));
    }
  };

  /** Bodies whose bounding box overlaps or touches the tool's. */
  const touching = (tool: Manifold): string[] => {
    const tb = tool.boundingBox();
    const eps = 1e-4;
    return [...bodies].filter(([, b]) => {
      const bb = b.m.boundingBox();
      return [0, 1, 2].every((i) => bb.min[i] <= tb.max[i] + eps && tb.min[i] <= bb.max[i] + eps);
    }).map(([id]) => id);
  };

  const profileSection = (s: SketchFeature, profiles?: number[]): { cs: CrossSection; open: string[] } => {
    const { loops, openCurveIds } = findProfiles(s);
    if (loops.length === 0) throw new Error('Sketch has no closed profile');
    let cs: CrossSection;
    if (profiles && profiles.length) {
      const regions = findRegions(s);
      const chosen = profiles.filter((i) => i >= 0 && i < regions.length);
      if (!chosen.length) throw new Error('Selected profiles no longer exist — reselect them');
      cs = T(CrossSection.union(chosen.map((i) => T(new CrossSection(regions[i].polys as MVec2[][], 'EvenOdd')))));
    } else {
      cs = T(new CrossSection(loops as MVec2[][], 'EvenOdd'));
    }
    if (cs.isEmpty()) throw new Error('Sketch profile is empty');
    return { cs, open: openCurveIds };
  };

  const getSketch = (id: string): SketchFeature => {
    const s = doc.features.find((x) => x.id === id);
    if (!s || s.type !== 'sketch') throw new Error('Referenced sketch not found');
    if (errors.has(s.id)) throw new Error('Referenced sketch has errors');
    if (!frames.has(s.id)) throw new Error('Referenced sketch is suppressed or after this feature');
    return s;
  };

  const active = doc.features.slice(0, doc.rollback ?? doc.features.length);

  for (const f of active) {
    if (f.suppressed) {
      bodiesAfter.set(f.id, [...bodies].map(([id, b]) => ({ id, name: b.name })));
      continue;
    }
    try {
      switch (f.type) {
        case 'sketch': {
          frames.set(f.id, sketchFrame(f, scope));
          if (opts.skipSolve !== f.id && f.constraints.length > 0) {
            const r = solveSketch(f, scope);
            solves.set(f.id, r);
            if (!r.ok) warnings.set(f.id, r.message ?? 'Sketch did not solve');
          }
          break;
        }
        case 'extrude': {
          const s = getSketch(f.sketch);
          const frame = frames.get(s.id)!;
          const { cs, open } = profileSection(s, f.profiles);
          if (open.length) warnings.set(f.id, `${open.length} open curve(s) ignored`);
          let h = E(f.distance, 'Distance');
          if (Math.abs(h) < 1e-9) throw new Error('Distance must not be 0');
          let dir = f.direction;
          if (h < 0) {
            h = -h;
            if (dir === 'normal') dir = 'reverse';
            else if (dir === 'reverse') dir = 'normal';
          }
          const taper = f.taper ? E(f.taper, 'Taper') : 1;
          let base = cs;
          let m: Manifold;
          if (Math.abs(taper - 1) > 1e-9) {
            const bb = cs.bounds();
            const c: MVec2 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2];
            base = T(cs.translate([-c[0], -c[1]]));
            m = T(base.extrude(h, 0, 0, [Math.max(0, taper), Math.max(0, taper)], dir === 'symmetric'));
            m = T(m.translate([c[0], c[1], 0]));
          } else {
            m = T(cs.extrude(h, 0, 0, [1, 1], dir === 'symmetric'));
          }
          if (dir === 'reverse') m = T(m.mirror([0, 0, 1]));
          m = T(m.transform(frameMatrix(frame) as any));
          applyOp(f, f.op, f.target, m);
          break;
        }
        case 'revolve': {
          const s = getSketch(f.sketch);
          const frame = frames.get(s.id)!;
          const pts = pointMap(s);
          let P: Vec2 = [0, 0], d: Vec2 = [0, 1];
          if (f.axis === 'X') d = [1, 0];
          else if (f.axis !== 'Y') {
            const l = s.curves.find((c) => c.id === f.axis);
            if (!l || l.type !== 'line') throw new Error('Axis line not found in sketch');
            const a = pts.get(l.p1)!, b = pts.get(l.p2)!;
            P = [a.x, a.y];
            const L = Math.hypot(b.x - a.x, b.y - a.y);
            if (L < 1e-9) throw new Error('Axis line has zero length');
            d = [(b.x - a.x) / L, (b.y - a.y) / L];
          }
          const e1: Vec2 = [d[1], -d[0]];
          // exclude the axis line itself from the profile
          const s2: SketchFeature = { ...s, curves: s.curves.filter((c) => c.id !== f.axis) };
          const loops = profileSection(s2, f.profiles).cs.toPolygons() as Vec2[][];
          if (!loops.length) throw new Error('Sketch has no closed profile');
          let mapped = loops.map((loop) => loop.map(([x, y]) => [(x - P[0]) * e1[0] + (y - P[1]) * e1[1], (x - P[0]) * d[0] + (y - P[1]) * d[1]] as Vec2));
          const xs = mapped.flat().map((p) => p[0]);
          const sgn = Math.max(...xs) > 1e-9 ? 1 : -1;
          if (Math.min(...xs) < -1e-6 && Math.max(...xs) > 1e-6) warnings.set(f.id, 'Profile crosses the axis — only one side is used');
          if (sgn < 0) mapped = mapped.map((loop) => loop.map(([x, y]) => [-x, y] as Vec2));
          const cs = T(new CrossSection(mapped as MVec2[][], 'EvenOdd'));
          const ang = E(f.angle, 'Angle');
          if (ang <= 0 || ang > 360) throw new Error('Angle must be in (0, 360]');
          let m = T(cs.revolve(undefined, ang));
          const X: Vec3 = [e1[0] * sgn, e1[1] * sgn, 0];
          const Z: Vec3 = [d[0], d[1], 0];
          const Y: Vec3 = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
          const local: M4 = [...X, 0, ...Y, 0, ...Z, 0, P[0], P[1], 0, 1];
          m = T(m.transform(mul(frameMatrix(frame), local) as any));
          applyOp(f, f.op, f.target, m);
          break;
        }
        case 'primitive': {
          const [a, b, c] = f.size.map((x, i) => (x ? E(x, `Size ${i + 1}`) : 0));
          let m: Manifold;
          switch (f.shape) {
            case 'box':
              if (a <= 0 || b <= 0 || c <= 0) throw new Error('Box sizes must be > 0');
              m = T(Manifold.cube([a, b, c], f.centered));
              break;
            case 'cylinder':
              if (a <= 0 || b <= 0) throw new Error('Radius and height must be > 0');
              m = T(Manifold.cylinder(b, a, a, undefined, f.centered));
              break;
            case 'cone':
              if (a < 0 || b < 0 || c <= 0 || (a === 0 && b === 0)) throw new Error('Invalid cone dimensions');
              m = T(Manifold.cylinder(c, a, b, undefined, f.centered));
              break;
            case 'sphere':
              if (a <= 0) throw new Error('Radius must be > 0');
              m = T(Manifold.sphere(a));
              break;
            case 'torus': {
              if (a <= 0 || b <= 0 || b >= a) throw new Error('Torus needs major radius > minor radius > 0');
              const circ = T(CrossSection.circle(b).translate([a, 0]));
              m = T(circ.revolve());
              break;
            }
          }
          const rot = f.rotation.map((x, i) => E(x || '0', `Rotation ${'XYZ'[i]}`)) as Vec3;
          const pos = f.position.map((x, i) => E(x || '0', `Position ${'XYZ'[i]}`)) as Vec3;
          m = T(T(m.rotate(rot)).translate(pos));
          applyOp(f, f.op, f.target, m);
          break;
        }
        case 'boolean': {
          const tgt = bodies.get(f.target);
          if (!tgt) throw new Error('Select a target body');
          const tools = f.tools.filter((t) => t !== f.target).map((t) => bodies.get(t));
          if (!tools.length || tools.some((t) => !t)) throw new Error('Select one or more tool bodies');
          for (const t of tools) {
            tgt.m = T(f.op === 'union' ? tgt.m.add(t!.m) : f.op === 'subtract' ? tgt.m.subtract(t!.m) : tgt.m.intersect(t!.m));
          }
          if (!f.keepTools) for (const id of f.tools) if (id !== f.target) bodies.delete(id);
          break;
        }
        case 'transform': {
          if (!f.bodies.length) throw new Error('Select bodies to move');
          const tr = f.translate.map((x) => E(x || '0', 'Translate')) as Vec3;
          const rot = f.rotate.map((x) => E(x || '0', 'Rotate')) as Vec3;
          const sc = E(f.scale || '1', 'Scale');
          if (sc <= 0) throw new Error('Scale must be > 0');
          for (const id of f.bodies) {
            const b = bodies.get(id);
            if (!b) throw new Error('A selected body no longer exists');
            const m = T(T(T(b.m.scale(sc)).rotate(rot)).translate(tr));
            if (f.copy) newBody(`${f.id}:${id}`, m, f.id);
            else b.m = m;
          }
          break;
        }
        case 'pattern': {
          if (!f.bodies.length) throw new Error('Select bodies to pattern');
          const n = Math.round(E(f.count, 'Count'));
          if (n < 1 || n > 500) throw new Error('Count must be between 1 and 500');
          const sp = E(f.spacing, f.kind === 'linear' ? 'Spacing' : 'Angle');
          const n2 = f.kind === 'linear' && f.count2 ? Math.round(E(f.count2, 'Count 2')) : 1;
          const sp2 = f.kind === 'linear' && f.spacing2 ? E(f.spacing2, 'Spacing 2') : 0;
          if (n * n2 > 2000) throw new Error('Too many instances');
          const ctr = f.center.map((x) => E(x || '0', 'Center')) as Vec3;
          for (const id of f.bodies) {
            const b = bodies.get(id);
            if (!b) throw new Error('A selected body no longer exists');
            const copies: Manifold[] = [];
            for (let j = 0; j < n2; j++) {
              for (let i = 0; i < n; i++) {
                if (i === 0 && j === 0) continue;
                if (f.kind === 'linear') {
                  const a1 = AXES[f.axis], a2 = AXES[f.axis2 ?? 'Y'];
                  const v: Vec3 = [0, 1, 2].map((k) => a1[k] * sp * i + a2[k] * sp2 * j) as Vec3;
                  copies.push(T(b.m.translate(v)));
                } else {
                  const full = Math.abs(Math.abs(sp) - 360) < 1e-9;
                  const step = n <= 1 ? 0 : full ? sp / n : sp / (n - 1);
                  const r: Vec3 = [0, 0, 0];
                  r['XYZ'.indexOf(f.axis)] = step * i;
                  copies.push(T(T(T(b.m.translate([-ctr[0], -ctr[1], -ctr[2]])).rotate(r)).translate(ctr)));
                }
              }
            }
            if (f.merge) b.m = T(Manifold.union([b.m, ...copies]));
            else copies.forEach((m, k) => newBody(`${f.id}:${id}:${k}`, m, f.id));
          }
          break;
        }
        case 'mirror': {
          if (!f.bodies.length) throw new Error('Select bodies to mirror');
          const nrm = ORIGIN_FRAMES[f.plane].z;
          const off = E(f.offset || '0', 'Offset');
          for (const id of f.bodies) {
            const b = bodies.get(id);
            if (!b) throw new Error('A selected body no longer exists');
            const sh: Vec3 = [nrm[0] * off, nrm[1] * off, nrm[2] * off];
            const m = T(T(T(b.m.translate([-sh[0], -sh[1], -sh[2]])).mirror(nrm)).translate(sh));
            if (f.merge) b.m = T(b.m.add(m));
            else newBody(`${f.id}:${id}`, m, f.id);
          }
          break;
        }
      }
    } catch (e) {
      errors.set(f.id, (e as Error).message);
    }
    bodiesAfter.set(f.id, [...bodies].map(([id, b]) => ({ id, name: b.name })));
  }

  // ---- extract meshes
  const out: BodyMesh[] = [];
  for (const [id, b] of bodies) {
    if (b.m.isEmpty()) continue;
    let mm = b.m;
    try {
      mm = T(b.m.calculateNormals(0, 30));
    } catch {
      /* fall back to flat normals */
    }
    const mesh = mm.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const positions = new Float32Array(nv * 3);
    const normals = np >= 6 ? new Float32Array(nv * 3) : null;
    for (let i = 0; i < nv; i++) {
      positions[i * 3] = mesh.vertProperties[i * np];
      positions[i * 3 + 1] = mesh.vertProperties[i * np + 1];
      positions[i * 3 + 2] = mesh.vertProperties[i * np + 2];
      if (normals) {
        normals[i * 3] = mesh.vertProperties[i * np + 3];
        normals[i * 3 + 1] = mesh.vertProperties[i * np + 4];
        normals[i * 3 + 2] = mesh.vertProperties[i * np + 5];
      }
    }
    const numTri = mesh.triVerts.length / 3;
    const faceIds = mesh.faceID && mesh.faceID.length === numTri ? new Uint32Array(mesh.faceID) : new Uint32Array(numTri);
    const bb = b.m.boundingBox();
    out.push({
      id,
      name: b.name,
      featureId: b.featureId,
      positions,
      normals,
      indices: new Uint32Array(mesh.triVerts),
      faceIds,
      volume: b.m.volume(),
      area: b.m.surfaceArea(),
      bbox: { min: [...bb.min] as Vec3, max: [...bb.max] as Vec3 },
      triangles: numTri,
    });
  }

  for (const g of garbage) {
    try {
      g.delete();
    } catch {
      /* already freed */
    }
  }

  return { bodies: out, errors, warnings, frames, solves, scope, bodiesAfter, timeMs: performance.now() - t0 };
}
