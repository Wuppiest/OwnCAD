// Bridge between OwnCAD sketches and the FreeCAD planegcs constraint solver (WASM).

import { GcsWrapper, init_planegcs_module, SolveStatus } from '@salusoft89/planegcs';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { SketchConstraint, SketchFeature } from '../model/types';
import type { ParamScope } from '../model/expr';
import { arcAngles, pointMap, TAU } from './geom';

let gcs: GcsWrapper | null = null;

export async function initSolver() {
  const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
  gcs = new GcsWrapper(new mod.GcsSystem(), mod);
}

export interface SolveResult {
  ok: boolean;
  dof: number;
  conflicting: string[];
  redundant: string[];
  message?: string;
}

export interface SolveOptions {
  /** Points that should stay where they are during this solve (drag targets). */
  pinned?: Set<string>;
  /** Override the radius of circles/arcs before solving (drag a circle edge). */
  radiusOverride?: Map<string, number>;
}

/** Evaluated numeric value of a dimension. Angles return degrees. */
export function dimensionValue(c: SketchConstraint, scope: ParamScope): number {
  return scope.eval(c.value ?? '0');
}

/**
 * Solves the sketch in place: point coordinates and radii are updated.
 */
export function solveSketch(sketch: SketchFeature, scope: ParamScope, opts: SolveOptions = {}): SolveResult {
  if (!gcs) return { ok: false, dof: -1, conflicting: [], redundant: [], message: 'Solver not loaded' };
  const pts = pointMap(sketch);
  const curves = new Map(sketch.curves.map((c) => [c.id, c]));

  // planegcs requires referenced ids to be pushed earlier, and ids are strings.
  // We map our ids to sequential numeric ids.
  const idOf = new Map<string, string>();
  let counter = 0;
  const gid = (id: string) => {
    if (!idOf.has(id)) idOf.set(id, String(counter++));
    return idOf.get(id)!;
  };
  const prims: any[] = [];

  for (const p of sketch.points) {
    prims.push({ id: gid(p.id), type: 'point', x: p.x, y: p.y, fixed: !!p.fixed || !!opts.pinned?.has(p.id) });
  }
  for (const c of sketch.curves) {
    if (c.type === 'line') {
      prims.push({ id: gid(c.id), type: 'line', p1_id: gid(c.p1), p2_id: gid(c.p2) });
    } else if (c.type === 'circle') {
      prims.push({ id: gid(c.id), type: 'circle', c_id: gid(c.c), radius: opts.radiusOverride?.get(c.id) ?? c.r });
    } else {
      const { a0, sweep } = arcAngles(c, pts);
      prims.push({
        id: gid(c.id), type: 'arc', c_id: gid(c.c), radius: opts.radiusOverride?.get(c.id) ?? c.r,
        start_angle: a0, end_angle: a0 + sweep, start_id: gid(c.s), end_id: gid(c.e),
      });
      prims.push({ id: gid(c.id + '#rules'), type: 'arc_rules', a_id: gid(c.id) });
    }
  }

  const tag = new Map<string, string>(); // gcs constraint id -> our constraint id
  const cons = (ourId: string, obj: any) => {
    const id = gid(ourId + '#' + prims.length);
    tag.set(id, ourId);
    prims.push({ id, ...obj });
  };
  const kind = (id: string) => curves.get(id)?.type ?? (pts.has(id) ? 'point' : undefined);

  for (const c of sketch.constraints) {
    if (c.reference) continue;
    const r = c.refs;
    if (r.some((id) => !kind(id))) continue; // dangling reference
    let v = 0;
    if (c.value !== undefined) {
      try {
        v = dimensionValue(c, scope);
      } catch {
        continue; // invalid expression — skip constraint
      }
    }
    switch (c.type) {
      case 'coincident':
        cons(c.id, { type: 'p2p_coincident', p1_id: gid(r[0]), p2_id: gid(r[1]) });
        break;
      case 'pointOnCurve': {
        const k = kind(r[1]);
        if (k === 'line') cons(c.id, { type: 'point_on_line_pl', p_id: gid(r[0]), l_id: gid(r[1]) });
        else if (k === 'circle') cons(c.id, { type: 'point_on_circle', p_id: gid(r[0]), c_id: gid(r[1]) });
        else if (k === 'arc') cons(c.id, { type: 'point_on_arc', p_id: gid(r[0]), a_id: gid(r[1]) });
        break;
      }
      case 'horizontal':
        if (r.length === 1) cons(c.id, { type: 'horizontal_l', l_id: gid(r[0]) });
        else cons(c.id, { type: 'horizontal_pp', p1_id: gid(r[0]), p2_id: gid(r[1]) });
        break;
      case 'vertical':
        if (r.length === 1) cons(c.id, { type: 'vertical_l', l_id: gid(r[0]) });
        else cons(c.id, { type: 'vertical_pp', p1_id: gid(r[0]), p2_id: gid(r[1]) });
        break;
      case 'parallel':
        cons(c.id, { type: 'parallel', l1_id: gid(r[0]), l2_id: gid(r[1]) });
        break;
      case 'perpendicular':
        cons(c.id, { type: 'perpendicular_ll', l1_id: gid(r[0]), l2_id: gid(r[1]) });
        break;
      case 'equal': {
        const [k1, k2] = [kind(r[0]), kind(r[1])];
        if (k1 === 'line' && k2 === 'line') cons(c.id, { type: 'equal_length', l1_id: gid(r[0]), l2_id: gid(r[1]) });
        else if (k1 === 'circle' && k2 === 'circle') cons(c.id, { type: 'equal_radius_cc', c1_id: gid(r[0]), c2_id: gid(r[1]) });
        else if (k1 === 'arc' && k2 === 'arc') cons(c.id, { type: 'equal_radius_aa', a1_id: gid(r[0]), a2_id: gid(r[1]) });
        else if (k1 === 'circle' && k2 === 'arc') cons(c.id, { type: 'equal_radius_ca', c1_id: gid(r[0]), a2_id: gid(r[1]) });
        else if (k1 === 'arc' && k2 === 'circle') cons(c.id, { type: 'equal_radius_ca', c1_id: gid(r[1]), a2_id: gid(r[0]) });
        break;
      }
      case 'tangent': {
        let [a, b] = r;
        if (kind(b) === 'line') [a, b] = [b, a];
        const [ka, kb] = [kind(a), kind(b)];
        // Tangency at a shared endpoint: use FreeCAD's angle-via-point formulation
        // (plain tangent + coincident endpoint makes the Jacobian singular → "redundant").
        const ends = (id: string): string[] => {
          const cv = curves.get(id);
          return cv?.type === 'line' ? [cv.p1, cv.p2] : cv?.type === 'arc' ? [cv.s, cv.e] : [];
        };
        const shared = ends(a).find((p) => ends(b).includes(p));
        if (shared && (ka === 'arc' || kb === 'arc')) {
          const P0 = pts.get(shared)!;
          const normal = (id: string): [number, number] => {
            const cv = curves.get(id)!;
            if (cv.type === 'line') {
              const p1 = pts.get(cv.p1)!, p2 = pts.get(cv.p2)!;
              return [-(p2.y - p1.y), p2.x - p1.x]; // rotate90ccw(p2 - p1)
            }
            const c0 = pts.get(cv.c)!;
            return [c0.x - P0.x, c0.y - P0.y]; // center - point
          };
          const n1 = normal(a), n2 = normal(b);
          const ang = n1[0] * n2[0] + n1[1] * n2[1] >= 0 ? 0 : Math.PI;
          cons(c.id, { type: 'angle_via_point', crv1_id: gid(a), crv2_id: gid(b), p_id: gid(shared), angle: ang });
          break;
        }
        if (ka === 'line' && kb === 'circle') cons(c.id, { type: 'tangent_lc', l_id: gid(a), c_id: gid(b) });
        else if (ka === 'line' && kb === 'arc') cons(c.id, { type: 'tangent_la', l_id: gid(a), a_id: gid(b) });
        else if (ka === 'circle' && kb === 'circle') cons(c.id, { type: 'tangent_cc', c1_id: gid(a), c2_id: gid(b) });
        else if (ka === 'arc' && kb === 'arc') cons(c.id, { type: 'tangent_aa', a1_id: gid(a), a2_id: gid(b) });
        break;
      }
      case 'midpoint': {
        const l = curves.get(r[1]);
        if (l?.type === 'line') cons(c.id, { type: 'p2p_symmetric_ppp', p1_id: gid(l.p1), p2_id: gid(l.p2), p_id: gid(r[0]) });
        break;
      }
      case 'symmetric':
        cons(c.id, { type: 'p2p_symmetric_ppl', p1_id: gid(r[0]), p2_id: gid(r[1]), l_id: gid(r[2]) });
        break;
      case 'concentric': {
        const a = curves.get(r[0]), b = curves.get(r[1]);
        if (a && b && a.type !== 'line' && b.type !== 'line') cons(c.id, { type: 'p2p_coincident', p1_id: gid(a.c), p2_id: gid(b.c) });
        break;
      }
      case 'fix': {
        const p = pts.get(r[0]);
        if (p) {
          cons(c.id, { type: 'coordinate_x', p_id: gid(p.id), x: p.x });
          cons(c.id, { type: 'coordinate_y', p_id: gid(p.id), y: p.y });
        }
        break;
      }
      case 'distance': {
        if (r.length === 1) {
          const l = curves.get(r[0]);
          if (l?.type === 'line') cons(c.id, { type: 'p2p_distance', p1_id: gid(l.p1), p2_id: gid(l.p2), distance: v });
        } else if (kind(r[1]) === 'line') {
          cons(c.id, { type: 'p2l_distance', p_id: gid(r[0]), l_id: gid(r[1]), distance: v });
        } else {
          cons(c.id, { type: 'p2p_distance', p1_id: gid(r[0]), p2_id: gid(r[1]), distance: v });
        }
        break;
      }
      case 'hdistance':
        cons(c.id, { type: 'difference', param1: { o_id: gid(r[0]), prop: 'x' }, param2: { o_id: gid(r[1]), prop: 'x' }, difference: v });
        break;
      case 'vdistance':
        cons(c.id, { type: 'difference', param1: { o_id: gid(r[0]), prop: 'y' }, param2: { o_id: gid(r[1]), prop: 'y' }, difference: v });
        break;
      case 'radius':
      case 'diameter': {
        const rad = c.type === 'diameter' ? v / 2 : v;
        if (kind(r[0]) === 'circle') cons(c.id, { type: 'circle_radius', c_id: gid(r[0]), radius: rad });
        else cons(c.id, { type: 'arc_radius', a_id: gid(r[0]), radius: rad });
        break;
      }
      case 'angle': {
        const l1 = curves.get(r[0]), l2 = curves.get(r[1]);
        if (l1?.type !== 'line' || l2?.type !== 'line') break;
        const d = (l: typeof l1) => {
          const a = pts.get(l.p1)!, b = pts.get(l.p2)!;
          return Math.atan2(b.y - a.y, b.x - a.x);
        };
        let cur = d(l2) - d(l1);
        while (cur > Math.PI) cur -= TAU;
        while (cur < -Math.PI) cur += TAU;
        const target = (Math.sign(cur) || 1) * (v * Math.PI) / 180;
        cons(c.id, { type: 'l2l_angle_ll', l1_id: gid(r[0]), l2_id: gid(r[1]), angle: target });
        break;
      }
    }
  }

  try {
    gcs.clear_data();
    gcs.push_primitives_and_params(prims);
    const status = gcs.solve();
    const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
    const conflicting = gcs.get_gcs_conflicting_constraints().map((id) => tag.get(id) ?? id);
    const redundant = gcs.get_gcs_redundant_constraints().map((id) => tag.get(id) ?? id);
    const dof = (gcs.gcs as any).dof?.() ?? -1;
    if (ok) {
      gcs.apply_solution();
      const back = new Map<string, any>();
      for (const p of gcs.sketch_index.get_primitives()) back.set(p.id, p);
      for (const p of sketch.points) {
        const s = back.get(gid(p.id));
        if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
          p.x = s.x;
          p.y = s.y;
        }
      }
      for (const c of sketch.curves) {
        if (c.type === 'line') continue;
        const s = back.get(gid(c.id));
        if (s && Number.isFinite(s.radius)) c.r = Math.abs(s.radius);
      }
    }
    return { ok, dof, conflicting, redundant, message: ok ? undefined : 'Sketch could not be solved' };
  } catch (e) {
    return { ok: false, dof: -1, conflicting: [], redundant: [], message: (e as Error).message };
  }
}
