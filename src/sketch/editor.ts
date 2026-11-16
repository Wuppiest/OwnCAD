// Interactive 2D sketch editor running on a plane inside the 3D viewport.

import * as THREE from 'three';
import type { DocStore } from '../model/document';
import type { ConstraintType, Frame, SketchConstraint, SketchCurve, SketchFeature, SketchPoint, Vec2 } from '../model/types';
import { DIMENSION_TYPES } from '../model/types';
import type { ParamScope } from '../model/expr';
import { fmt } from '../model/expr';
import type { Viewport } from '../view/viewport';
import type { NumericInput } from '../ui/numericInput';
import { solveSketch, type SolveOptions, type SolveResult } from './solver';
import {
  add, arcAngles, closestOnSegment, dist, distanceToCurve, frameMatrix, intersections, len, norm, normAngle,
  ORIGIN_ID, P, pointMap, scale, sub, TAU, toLocal, toWorld,
} from './geom';
import { BADGE, badgeAnchor, COLORS, curvePoly, dimensionLayout, measure, pointsObject, polyLine } from './render';
import { findProfiles } from './profiles';
import { kernel } from '../kernel/manifold';

export type SketchTool =
  | 'select' | 'line' | 'rect' | 'centerRect' | 'circle' | 'arc' | 'arc3' | 'polygon' | 'point'
  | 'fillet' | 'dimension' | 'project';

type SnapKind = 'point' | 'mid' | 'intersection' | 'ref' | 'onCurve' | 'grid' | 'align' | 'free';
interface Snap {
  pt: Vec2;
  kind: SnapKind;
  pointId?: string;
  curveId?: string;
  guides?: Vec2[][];
}

export interface EditorHost {
  store: DocStore;
  vp: Viewport;
  numeric: NumericInput;
  scope(): ParamScope;
  toast(msg: string, kind?: 'ok' | 'err'): void;
  status(msg: string): void;
  onSketchState(r: SolveResult | null): void;
  onSelection(): void;
  settings: { snapGrid: boolean; gridStep: number; snapObjects: boolean };
}

export const TOOL_HINTS: Record<SketchTool, string> = {
  select: 'Click to select · drag points/lines to move · drag a dimension to reposition · double-click a dimension to edit',
  line: 'Click start point, then click successive points. Type to enter length/angle. Esc / double-click ends the chain.',
  rect: 'Click first corner, then the opposite corner. Type width/height.',
  centerRect: 'Click the center, then a corner. Type width/height.',
  circle: 'Click the center, then a point on the circle. Type the diameter.',
  arc: 'Click the center, the start point, then the end point (direction follows the mouse).',
  arc3: 'Click the start point, the end point, then a point on the arc.',
  polygon: 'Click the center, then a vertex. Type number of sides and radius.',
  point: 'Click to place a point.',
  fillet: 'Click a corner where two lines meet. Type the radius first.',
  dimension: 'Pick a line, circle, arc, two points, a point and a line, or two lines — then click to place the dimension.',
  project: 'Click an edge of the model (purple) to project it into the sketch as fixed geometry.',
};

export class SketchEditor {
  readonly id: string;
  frame: Frame;
  tool: SketchTool = 'select';
  sel = new Set<string>();
  hover: string | null = null;
  lastSolve: SolveResult | null = null;

  private group = new THREE.Group();
  private preview = new THREE.Group();
  private labels: { el: HTMLElement; at: Vec2 }[] = [];
  private refSegments: Vec2[][] = [];
  private clicks: Snap[] = [];
  private chainStart: string | null = null;
  private arcAcc = 0;
  private arcLastAng = 0;
  private dimRefs: string[] = [];
  private mouse: Vec2 = [0, 0];
  private lastScreen = { x: 0, y: 0 };
  private curSnap: Snap | null = null;
  private drag:
    | { kind: 'points'; ids: string[]; start: Vec2; orig: Map<string, Vec2> }
    | { kind: 'circle'; id: string }
    | { kind: 'label'; id: string; start: Vec2; orig: Vec2 }
    | { kind: 'box'; start: Vec2; sx: number; sy: number; box: HTMLDivElement }
    | null = null;
  private dimEditor: HTMLInputElement | null = null;
  private filletRadius = 2;
  private polygonSides = 6;

  constructor(private host: EditorHost, sketchId: string, frame: Frame) {
    this.id = sketchId;
    this.frame = frame;
    for (const g of [this.group, this.preview]) {
      g.matrixAutoUpdate = false;
      g.matrix.fromArray(frameMatrix(frame));
      host.vp.overlayGroup.add(g);
    }
    host.vp.onFrame(this.frameHook);
    this.computeRefs();
    this.solve();
    this.rebuild();
  }

  get sketch(): SketchFeature {
    return this.host.store.sketch(this.id)!;
  }

  private alive = true;
  private frameHook = () => {
    if (!this.alive) return;
    const r = this.host.vp.renderer.domElement.getBoundingClientRect();
    for (const l of this.labels) {
      const s = this.host.vp.toScreen(new THREE.Vector3(...toWorld(this.frame, l.at)), r);
      if (!s) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = '';
      l.el.style.left = `${s.x}px`;
      l.el.style.top = `${s.y}px`;
    }
  };

  dispose() {
    this.alive = false;
    this.closeDimEditor(false);
    this.host.vp.overlayGroup.remove(this.group, this.preview);
    this.clearLabels();
    this.host.numeric.hide();
  }

  setFrame(frame: Frame) {
    this.frame = frame;
    for (const g of [this.group, this.preview]) g.matrix.fromArray(frameMatrix(frame));
    this.computeRefs();
  }

  // ================================================================ tools

  setTool(t: SketchTool) {
    this.cancelOp();
    this.tool = t;
    this.host.status(TOOL_HINTS[t]);
    this.updateNumericFields();
    if (t !== 'select') {
      this.sel.clear();
      this.host.onSelection();
    }
    this.rebuild();
  }

  /** Cancel the current in-progress operation. Returns true if something was cancelled. */
  cancelOp(): boolean {
    const had = this.clicks.length > 0 || this.dimRefs.length > 0 || !!this.drag;
    this.clicks = [];
    this.dimRefs = [];
    this.chainStart = null;
    if (this.drag?.kind === 'box') this.drag.box.remove();
    if (this.drag && this.drag.kind !== 'box') this.host.store.cancelGesture();
    this.drag = null;
    this.host.numeric.reset();
    this.updateNumericFields();
    this.clearPreview();
    return had;
  }

  escape() {
    if (this.dimEditor) return this.closeDimEditor(false);
    if (this.cancelOp()) return;
    if (this.tool !== 'select') return this.setTool('select');
    if (this.sel.size) {
      this.sel.clear();
      this.host.onSelection();
      this.rebuild();
    }
  }

  private updateNumericFields() {
    const n = this.host.numeric;
    const c = this.clicks.length;
    let defs: { key: string; label: string }[] = [];
    switch (this.tool) {
      case 'line': defs = c === 0 ? [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }] : [{ key: 'len', label: 'Length' }, { key: 'ang', label: 'Angle' }]; break;
      case 'rect': case 'centerRect': defs = c === 0 ? [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }] : [{ key: 'w', label: 'Width' }, { key: 'h', label: 'Height' }]; break;
      case 'circle': defs = c === 0 ? [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }] : [{ key: 'd', label: 'Diameter' }]; break;
      case 'arc': defs = c === 0 ? [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }] : c === 1 ? [{ key: 'r', label: 'Radius' }] : [{ key: 'ang', label: 'Sweep' }]; break;
      case 'polygon': defs = c === 0 ? [{ key: 'n', label: 'Sides' }, { key: 'x', label: 'X' }, { key: 'y', label: 'Y' }] : [{ key: 'n', label: 'Sides' }, { key: 'r', label: 'Radius' }]; break;
      case 'point': defs = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }]; break;
      case 'fillet': defs = [{ key: 'r', label: 'Radius' }]; break;
      default: defs = [];
    }
    if (!defs.length) {
      n.hide();
      n.fields = [];
      return;
    }
    n.setFields(defs);
    n.onChange = () => this.onMove(null);
    n.onCommit = () => this.commitNumeric();
    n.onCancel = () => this.escape();
    if (this.tool === 'fillet') n.setLive({ r: this.filletRadius });
    if (this.tool === 'polygon') n.setLive({ n: this.polygonSides });
    n.show(this.lastScreen.x, this.lastScreen.y);
  }

  // ================================================================ mutations

  private edit(reason: string, fn: (s: SketchFeature) => void, solveOpts?: SolveOptions) {
    this.host.store.commit(reason, () => {
      const s = this.sketch;
      fn(s);
      this.lastSolve = solveSketch(s, this.host.scope(), solveOpts);
    });
    this.host.onSketchState(this.lastSolve);
  }

  solve() {
    this.host.store.silent(() => {
      this.lastSolve = solveSketch(this.sketch, this.host.scope());
    });
    this.host.onSketchState(this.lastSolve);
  }

  private nid(prefix: string) {
    return this.host.store.newId(prefix);
  }

  private addPoint(s: SketchFeature, snap: Snap): string {
    if (snap.pointId && s.points.some((p) => p.id === snap.pointId)) return snap.pointId;
    const id = this.nid('p');
    s.points.push({ id, x: snap.pt[0], y: snap.pt[1] });
    if (snap.kind === 'onCurve' && snap.curveId) s.constraints.push({ id: this.nid('c'), type: 'pointOnCurve', refs: [id, snap.curveId] });
    if (snap.kind === 'mid' && snap.curveId) s.constraints.push({ id: this.nid('c'), type: 'midpoint', refs: [id, snap.curveId] });
    return id;
  }

  private con(s: SketchFeature, type: ConstraintType, refs: string[], value?: number, offset?: Vec2, expr?: string) {
    const c: SketchConstraint = { id: this.nid('c'), type, refs };
    if (value !== undefined) c.value = expr && isNaN(Number(expr)) ? expr.trim() : fmt(value, 4);
    if (offset) c.offset = offset;
    s.constraints.push(c);
    return c;
  }

  // ================================================================ snapping

  private pixel(): number {
    return this.host.vp.pixelSize(new THREE.Vector3(...toWorld(this.frame, this.mouse)));
  }

  private snap(m: Vec2, shift: boolean, exclude: Set<string> = new Set()): Snap {
    const s = this.sketch;
    const pts = pointMap(s);
    const tol = this.pixel() * 10;
    const anchor = this.clicks.length ? this.clicks[this.clicks.length - 1].pt : null;

    // ortho (shift) for line-like tools
    if (shift && anchor && ['line', 'arc3'].includes(this.tool)) {
      const d = sub(m, anchor);
      m = Math.abs(d[0]) > Math.abs(d[1]) ? [m[0], anchor[1]] : [anchor[0], m[1]];
    }

    if (this.host.settings.snapObjects) {
      let best: Snap | null = null, bd = tol;
      for (const p of s.points) {
        if (exclude.has(p.id)) continue;
        const d = dist(m, P(p));
        if (d < bd) { bd = d; best = { pt: P(p), kind: 'point', pointId: p.id }; }
      }
      if (best) return best;
      for (const c of s.curves) {
        if (c.type !== 'line' || exclude.has(c.id) || exclude.has(c.p1) || exclude.has(c.p2)) continue;
        const mid = scale(add(P(pts.get(c.p1)!), P(pts.get(c.p2)!)), 0.5);
        const d = dist(m, mid);
        if (d < bd) { bd = d; best = { pt: mid, kind: 'mid', curveId: c.id }; }
      }
      if (best) return best;
      for (const seg of this.refSegments) {
        for (const q of [seg[0], seg[1], scale(add(seg[0], seg[1]), 0.5)]) {
          const d = dist(m, q);
          if (d < bd) { bd = d; best = { pt: q, kind: 'ref' }; }
        }
      }
      if (best) return best;
      const near = s.curves.filter((c) => !exclude.has(c.id) && distanceToCurve(m, c, pts) < tol * 2);
      for (let i = 0; i < near.length; i++)
        for (let j = i + 1; j < near.length; j++)
          for (const q of intersections(near[i], near[j], pts)) {
            const d = dist(m, q);
            if (d < bd) { bd = d; best = { pt: q, kind: 'intersection' }; }
          }
      if (best) return best;
      let bc: SketchCurve | null = null, bcd = tol * 0.8;
      for (const c of near) {
        const d = distanceToCurve(m, c, pts);
        if (d < bcd) { bcd = d; bc = c; }
      }
      if (bc) {
        let q: Vec2;
        if (bc.type === 'line') q = closestOnSegment(m, P(pts.get(bc.p1)!), P(pts.get(bc.p2)!)).pt;
        else {
          const c = P(pts.get(bc.c)!);
          q = add(c, scale(norm(sub(m, c)), bc.r));
        }
        return { pt: q, kind: 'onCurve', curveId: bc.id };
      }
    }

    // alignment inference with the anchor point
    const guides: Vec2[][] = [];
    let out: Vec2 = [...m];
    let kind: SnapKind = 'free';
    if (anchor && !shift) {
      if (Math.abs(m[0] - anchor[0]) < tol) { out[0] = anchor[0]; guides.push([anchor, [anchor[0], m[1]]]); kind = 'align'; }
      if (Math.abs(m[1] - anchor[1]) < tol) { out[1] = anchor[1]; guides.push([anchor, [m[0], anchor[1]]]); kind = 'align'; }
    }
    if (this.host.settings.snapGrid) {
      const g = this.host.settings.gridStep;
      if (!guides.some((gd) => gd[0][0] === gd[1][0])) out[0] = Math.round(out[0] / g) * g;
      if (!guides.some((gd) => gd[0][1] === gd[1][1])) out[1] = Math.round(out[1] / g) * g;
      if (kind === 'free') kind = 'grid';
    }
    return { pt: out, kind, guides };
  }

  // ================================================================ hit testing

  private hitTest(m: Vec2): string | null {
    const s = this.sketch;
    const pts = pointMap(s);
    const tol = this.pixel() * 8;
    let best: string | null = null, bd = tol;
    for (const p of s.points) {
      const d = dist(m, P(p));
      if (d < bd) { bd = d; best = p.id; }
    }
    if (best) return best;
    bd = tol;
    for (const c of s.curves) {
      const d = distanceToCurve(m, c, pts);
      if (d < bd) { bd = d; best = c.id; }
    }
    return best;
  }

  // ================================================================ pointer events

  onPointerDown(ev: PointerEvent) {
    if (ev.button !== 0) return;
    const m = this.host.vp.planePoint(ev, this.frame);
    if (!m) return;
    this.mouse = m;
    if (this.dimEditor) this.closeDimEditor(true);

    if (this.tool === 'select') {
      const hit = this.hitTest(m);
      const s = this.sketch;
      if (hit) {
        if (ev.shiftKey || ev.ctrlKey) {
          if (this.sel.has(hit)) this.sel.delete(hit);
          else this.sel.add(hit);
        } else if (!this.sel.has(hit)) {
          this.sel.clear();
          this.sel.add(hit);
        }
        this.host.onSelection();
        // start drag
        const pt = s.points.find((p) => p.id === hit);
        const cv = s.curves.find((c) => c.id === hit);
        if (pt && hit !== ORIGIN_ID && !pt.fixed) {
          this.startPointDrag([hit], m);
        } else if (cv?.type === 'line') {
          this.startPointDrag([cv.p1, cv.p2].filter((id) => id !== ORIGIN_ID), m);
        } else if (cv?.type === 'circle') {
          this.host.store.beginGesture();
          this.drag = { kind: 'circle', id: cv.id };
        } else if (cv?.type === 'arc') {
          this.startPointDrag([cv.c, cv.s, cv.e].filter((id) => id !== ORIGIN_ID), m);
        }
      } else {
        if (!ev.shiftKey && !ev.ctrlKey) this.sel.clear();
        this.host.onSelection();
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;border:1px dashed #60a5fa;background:rgba(96,165,250,.08);pointer-events:none;';
        this.host.vp.labelLayer.appendChild(box);
        const r = this.host.vp.renderer.domElement.getBoundingClientRect();
        this.drag = { kind: 'box', start: m, sx: ev.clientX - r.left, sy: ev.clientY - r.top, box };
      }
      this.rebuild();
      return;
    }

    if (this.tool === 'dimension') return this.dimensionClick(m, ev);
    if (this.tool === 'fillet') return this.filletClick(m);
    if (this.tool === 'project') return this.projectClick(m);

    const snap = this.curSnap ?? this.snap(m, ev.shiftKey);
    this.toolClick(this.applyLocks(snap));
  }

  private startPointDrag(ids: string[], m: Vec2) {
    if (!ids.length) return;
    const pts = pointMap(this.sketch);
    this.host.store.beginGesture();
    this.drag = { kind: 'points', ids, start: m, orig: new Map(ids.map((id) => [id, P(pts.get(id)!)])) };
  }

  onPointerMove(ev: PointerEvent) {
    const r = this.host.vp.renderer.domElement.getBoundingClientRect();
    this.lastScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const m = this.host.vp.planePoint(ev, this.frame);
    if (!m) return;
    this.mouse = m;
    if (this.host.numeric.visible && !this.host.numeric.focused) this.host.numeric.show(this.lastScreen.x, this.lastScreen.y);

    if (this.drag) return this.dragMove(ev, m);
    this.onMove(ev);
  }

  onPointerUp(_ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'box') {
      d.box.remove();
      const s = this.sketch;
      const a = d.start, b = this.mouse;
      const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      if (x1 - x0 < 1e-9 && y1 - y0 < 1e-9) return;
      const inside = (p: Vec2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
      const pts = pointMap(s);
      for (const p of s.points) if (p.id !== ORIGIN_ID && inside(P(p))) this.sel.add(p.id);
      for (const c of s.curves) if (curvePoly(c, pts).every(inside)) this.sel.add(c.id);
      this.host.onSelection();
      this.rebuild();
      return;
    }
    this.host.store.endGesture('sketch');
  }

  private dragMove(ev: PointerEvent, m: Vec2) {
    const d = this.drag!;
    if (d.kind === 'box') {
      const r = this.host.vp.renderer.domElement.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      Object.assign(d.box.style, { left: `${Math.min(x, d.sx)}px`, top: `${Math.min(y, d.sy)}px`, width: `${Math.abs(x - d.sx)}px`, height: `${Math.abs(y - d.sy)}px` });
      return;
    }
    if (d.kind === 'label') {
      const delta = sub(m, d.start);
      this.host.store.commit('sketch-drag', () => {
        const c = this.sketch.constraints.find((x) => x.id === d.id);
        if (c) c.offset = add(d.orig, delta);
      });
      return;
    }
    if (d.kind === 'circle') {
      const s = this.sketch;
      const c = s.curves.find((x) => x.id === d.id);
      if (!c || c.type === 'line') return;
      const ctr = s.points.find((p) => p.id === c.c)!;
      const r = Math.max(dist(m, P(ctr)), 1e-3);
      this.dragSolve({ radiusOverride: new Map([[c.id, r]]) }, () => {});
      return;
    }
    // points
    let delta = sub(m, d.start);
    if (d.ids.length === 1) {
      const sn = this.snap(m, ev.shiftKey, new Set(d.ids));
      delta = sub(sn.pt, d.orig.get(d.ids[0])!);
    }
    this.dragSolve({ pinned: new Set(d.ids) }, (s) => {
      for (const p of s.points) {
        const o = d.orig.get(p.id);
        if (o) {
          p.x = o[0] + delta[0];
          p.y = o[1] + delta[1];
        }
      }
    });
  }

  /** Apply a drag step; if the solve fails, retry without pins, else revert. */
  private dragSolve(opts: SolveOptions, move: (s: SketchFeature) => void) {
    this.host.store.commit('sketch-drag', () => {
      const s = this.sketch;
      const backup = JSON.stringify({ p: s.points, c: s.curves });
      move(s);
      let r = solveSketch(s, this.host.scope(), opts);
      if (!r.ok && opts.pinned) {
        r = solveSketch(s, this.host.scope(), {});
      }
      if (!r.ok) {
        const b = JSON.parse(backup);
        s.points = b.p;
        s.curves = b.c;
        r = solveSketch(s, this.host.scope());
      }
      this.lastSolve = r;
    });
    this.host.onSketchState(this.lastSolve);
  }

  onDoubleClick(_ev: MouseEvent) {
    if (this.tool === 'line' && this.clicks.length) {
      this.cancelOp();
    }
  }

  /** Called on mouse move (or numeric change) to refresh hover/preview. */
  private onMove(ev: PointerEvent | null) {
    const m = this.mouse;
    if (this.tool === 'select' || this.tool === 'dimension' || this.tool === 'fillet') {
      const h = this.hitTest(m);
      if (h !== this.hover) {
        this.hover = h;
        this.rebuild();
      }
      if (this.tool === 'dimension') this.drawDimPreview(m);
      return;
    }
    if (this.tool === 'project') {
      this.drawProjectPreview(m);
      return;
    }
    const sn = this.snap(m, ev?.shiftKey ?? false);
    this.curSnap = sn;
    this.drawToolPreview(this.applyLocks(sn));
  }

  // ================================================================ numeric locks

  /** Applies locked numeric fields to the snapped cursor position. */
  private applyLocks(snap: Snap): Snap {
    const n = this.host.numeric;
    const get = (k: string) => {
      const f = n.get(k);
      return f?.locked ? f.value : undefined;
    };
    const c = this.clicks;
    let pt: Vec2 = [...snap.pt];
    let locked = false;
    if (c.length === 0 || this.tool === 'point') {
      const x = get('x'), y = get('y');
      if (x !== undefined) { pt[0] = x; locked = true; }
      if (y !== undefined) { pt[1] = y; locked = true; }
    } else {
      const a = c[c.length - 1].pt;
      switch (this.tool) {
        case 'line': {
          const L = get('len'), A = get('ang');
          let dir = norm(sub(pt, a));
          if (len(sub(pt, a)) < 1e-9) dir = [1, 0];
          if (A !== undefined) dir = [Math.cos((A * Math.PI) / 180), Math.sin((A * Math.PI) / 180)];
          const l = L ?? (A !== undefined ? Math.max(0, (pt[0] - a[0]) * dir[0] + (pt[1] - a[1]) * dir[1]) : len(sub(pt, a)));
          if (L !== undefined || A !== undefined) { pt = add(a, scale(dir, l)); locked = true; }
          break;
        }
        case 'rect': case 'centerRect': {
          const W = get('w'), H = get('h');
          const f = this.tool === 'centerRect' ? 0.5 : 1;
          if (W !== undefined) { pt[0] = a[0] + Math.sign(pt[0] - a[0] || 1) * W * f; locked = true; }
          if (H !== undefined) { pt[1] = a[1] + Math.sign(pt[1] - a[1] || 1) * H * f; locked = true; }
          break;
        }
        case 'circle': {
          const D = get('d');
          if (D !== undefined) { pt = add(a, scale(len(sub(pt, a)) > 1e-9 ? norm(sub(pt, a)) : [1, 0], D / 2)); locked = true; }
          break;
        }
        case 'arc': {
          if (c.length === 1) {
            const R = get('r');
            if (R !== undefined) { pt = add(a, scale(len(sub(pt, a)) > 1e-9 ? norm(sub(pt, a)) : [1, 0], R)); locked = true; }
          } else {
            const A = get('ang');
            if (A !== undefined) {
              const ctr = c[0].pt, st = c[1].pt;
              const r = dist(ctr, st);
              const a0 = Math.atan2(st[1] - ctr[1], st[0] - ctr[0]);
              const sgn = this.arcAcc < 0 ? -1 : 1;
              this.arcAcc = sgn * (A * Math.PI) / 180;
              pt = [ctr[0] + r * Math.cos(a0 + this.arcAcc), ctr[1] + r * Math.sin(a0 + this.arcAcc)];
              locked = true;
            }
          }
          break;
        }
        case 'polygon': {
          const R = get('r');
          if (R !== undefined) { pt = add(a, scale(len(sub(pt, a)) > 1e-9 ? norm(sub(pt, a)) : [1, 0], R)); locked = true; }
          break;
        }
      }
    }
    if (!locked) return snap;
    return { pt, kind: 'free' };
  }

  private commitNumeric() {
    if (this.tool === 'fillet') {
      const r = this.host.numeric.get('r');
      if (r?.locked) this.filletRadius = r.value;
      this.host.status(`Fillet radius set to ${fmt(this.filletRadius)} — click a corner.`);
      return;
    }
    const sn = this.applyLocks(this.curSnap ?? { pt: this.mouse, kind: 'free' });
    this.toolClick(sn, true);
  }

  // ================================================================ drawing tools

  private toolClick(sn: Snap, fromKeyboard = false) {
    const c = this.clicks;
    const n = this.host.numeric;
    const locks = Object.fromEntries(n.fields.filter((f) => f.locked).map((f) => [f.key, f.value]));
    const txt = Object.fromEntries(n.fields.filter((f) => f.locked).map((f) => [f.key, f.text]));
    const need: Record<string, number> = { line: 2, rect: 2, centerRect: 2, circle: 2, arc: 3, arc3: 3, polygon: 2, point: 1 };
    const tool = this.tool;

    if (tool === 'arc' && c.length === 1) {
      this.arcAcc = 0;
      this.arcLastAng = Math.atan2(sn.pt[1] - c[0].pt[1], sn.pt[0] - c[0].pt[0]);
    }
    c.push(sn);
    if (c.length < need[tool]) {
      n.reset();
      this.updateNumericFields();
      return;
    }

    const pts = c.map((x) => x);
    this.edit('sketch', (s) => {
      switch (tool) {
        case 'point':
          this.addPoint(s, pts[0]);
          break;
        case 'line': {
          const a = this.addPoint(s, pts[0]);
          if (len(sub(pts[1].pt, pts[0].pt)) < 1e-9) return;
          const b = this.addPoint(s, pts[1]);
          if (a === b) return;
          const id = this.nid('l');
          s.curves.push({ id, type: 'line', p1: a, p2: b });
          const d = sub(pts[1].pt, pts[0].pt);
          const ang = Math.abs(Math.atan2(d[1], d[0]));
          const tolA = 1e-6;
          if (Math.abs(d[1]) < 1e-9 || locks.ang === 0 || locks.ang === 180) this.con(s, 'horizontal', [id]);
          else if (Math.abs(d[0]) < 1e-9 || locks.ang === 90 || locks.ang === 270) this.con(s, 'vertical', [id]);
          void ang; void tolA;
          if (locks.len !== undefined) {
            const m = scale(add(pts[0].pt, pts[1].pt), 0.5);
            void m;
            this.con(s, 'distance', [id], locks.len, scale(norm([-d[1], d[0]]), 5), txt.len);
          }
          if (!this.chainStart) this.chainStart = a;
          // keep chaining from b
          this.pendingChain = { id: b, pt: pts[1].pt, closed: b === this.chainStart };
          break;
        }
        case 'rect':
        case 'centerRect': {
          let p0 = pts[0].pt, p2 = pts[1].pt;
          let centerSnap: Snap | null = null;
          if (tool === 'centerRect') {
            centerSnap = pts[0];
            const h = sub(p2, p0);
            p0 = sub(pts[0].pt, h);
            p2 = add(pts[0].pt, h);
          }
          if (Math.abs(p2[0] - p0[0]) < 1e-9 || Math.abs(p2[1] - p0[1]) < 1e-9) return;
          const corners: Vec2[] = [p0, [p2[0], p0[1]], p2, [p0[0], p2[1]]];
          const ids = corners.map((q, i) => {
            if (tool === 'rect' && i === 0) return this.addPoint(s, pts[0]);
            if (i === 2 && !fromKeyboard && tool === 'rect') return this.addPoint(s, { ...pts[1], pt: q });
            return this.addPoint(s, { pt: q, kind: 'free' });
          });
          const lids = ids.map((id, i) => {
            const lid = this.nid('l');
            s.curves.push({ id: lid, type: 'line', p1: id, p2: ids[(i + 1) % 4] });
            return lid;
          });
          this.con(s, 'horizontal', [lids[0]]);
          this.con(s, 'horizontal', [lids[2]]);
          this.con(s, 'vertical', [lids[1]]);
          this.con(s, 'vertical', [lids[3]]);
          if (centerSnap) {
            const cid = this.addPoint(s, centerSnap);
            const diag = this.nid('l');
            s.curves.push({ id: diag, type: 'line', p1: ids[0], p2: ids[2], construction: true });
            this.con(s, 'midpoint', [cid, diag]);
          }
          const w = Math.abs(p2[0] - p0[0]), h = Math.abs(p2[1] - p0[1]);
          if (locks.w !== undefined) this.con(s, 'distance', [lids[0]], w, [0, -Math.sign(p2[1] - p0[1]) * 6], txt.w);
          if (locks.h !== undefined) this.con(s, 'distance', [lids[1]], h, [Math.sign(p2[0] - p0[0]) * 6, 0], txt.h);
          break;
        }
        case 'circle': {
          const r = dist(pts[0].pt, pts[1].pt);
          if (r < 1e-6) return;
          const cid = this.addPoint(s, pts[0]);
          const id = this.nid('k');
          s.curves.push({ id, type: 'circle', c: cid, r });
          if (locks.d !== undefined) this.con(s, 'diameter', [id], locks.d, undefined, txt.d);
          break;
        }
        case 'arc': {
          const ctr = pts[0].pt, st = pts[1].pt;
          const r = dist(ctr, st);
          if (r < 1e-6 || Math.abs(this.arcAcc) < 1e-6) return;
          const a0 = Math.atan2(st[1] - ctr[1], st[0] - ctr[0]);
          const endPt: Vec2 = [ctr[0] + r * Math.cos(a0 + this.arcAcc), ctr[1] + r * Math.sin(a0 + this.arcAcc)];
          const cid = this.addPoint(s, pts[0]);
          const sid = this.addPoint(s, pts[1]);
          const endSnap: Snap = pts[2].kind === 'point' && Math.abs(dist(pts[2].pt, ctr) - r) < 1e-6 ? pts[2] : { pt: endPt, kind: 'free' };
          const eid = this.addPoint(s, endSnap);
          const [S, E] = this.arcAcc > 0 ? [sid, eid] : [eid, sid];
          const id = this.nid('a');
          s.curves.push({ id, type: 'arc', c: cid, s: S, e: E, r });
          if (locks.r !== undefined) this.con(s, 'radius', [id], locks.r, undefined, txt.r);
          break;
        }
        case 'arc3': {
          const circ = circumcircle(pts[0].pt, pts[1].pt, pts[2].pt);
          if (!circ) return;
          const sid = this.addPoint(s, pts[0]);
          const eid = this.addPoint(s, pts[1]);
          const cid = this.addPoint(s, { pt: circ.c, kind: 'free' });
          const cr = cross(sub(pts[2].pt, pts[0].pt), sub(pts[1].pt, pts[0].pt));
          const [S, E] = cr > 0 ? [sid, eid] : [eid, sid];
          s.curves.push({ id: this.nid('a'), type: 'arc', c: cid, s: S, e: E, r: circ.r });
          break;
        }
        case 'polygon': {
          const nS = Math.max(3, Math.min(64, Math.round(this.host.numeric.get('n')?.value || this.polygonSides)));
          this.polygonSides = nS;
          const ctr = pts[0].pt;
          const R = dist(ctr, pts[1].pt);
          if (R < 1e-6) return;
          const a0 = Math.atan2(pts[1].pt[1] - ctr[1], pts[1].pt[0] - ctr[0]);
          const cid = this.addPoint(s, pts[0]);
          const circ = this.nid('k');
          s.curves.push({ id: circ, type: 'circle', c: cid, r: R, construction: true });
          const ids: string[] = [];
          for (let i = 0; i < nS; i++) {
            const a = a0 + (i / nS) * TAU;
            const id = this.addPoint(s, { pt: [ctr[0] + R * Math.cos(a), ctr[1] + R * Math.sin(a)], kind: 'free' });
            ids.push(id);
            this.con(s, 'pointOnCurve', [id, circ]);
          }
          const lids = ids.map((id, i) => {
            const lid = this.nid('l');
            s.curves.push({ id: lid, type: 'line', p1: id, p2: ids[(i + 1) % nS] });
            return lid;
          });
          for (let i = 1; i < nS; i++) this.con(s, 'equal', [lids[0], lids[i]]);
          if (locks.r !== undefined) this.con(s, 'radius', [circ], locks.r, undefined, txt.r);
          break;
        }
      }
    });

    // post-step state
    this.host.numeric.reset();
    if (tool === 'line' && this.pendingChain) {
      const pc = this.pendingChain;
      this.pendingChain = null;
      if (pc.closed) {
        this.clicks = [];
        this.chainStart = null;
      } else {
        this.clicks = [{ pt: pc.pt, kind: 'point', pointId: pc.id }];
      }
    } else {
      this.clicks = [];
    }
    this.curSnap = null;
    this.updateNumericFields();
    this.clearPreview();
    this.rebuild();
  }

  private pendingChain: { id: string; pt: Vec2; closed: boolean } | null = null;

  // ================================================================ previews

  private clearPreview() {
    this.preview.traverse((o) => (o as any).geometry?.dispose?.());
    this.preview.clear();
  }

  private drawSnapMarker(sn: Snap) {
    const col = sn.kind === 'point' ? 0x22c55e : sn.kind === 'mid' ? 0x14b8a6 : sn.kind === 'onCurve' ? 0xeab308 : sn.kind === 'intersection' ? 0xf43f5e : sn.kind === 'ref' ? 0xa78bfa : 0x93c5fd;
    this.preview.add(pointsObject([{ p: sn.pt, color: col }], sn.kind === 'free' || sn.kind === 'grid' ? 6 : 11));
    for (const g of sn.guides ?? []) this.preview.add(polyLine(g, 0x64748b, { dashed: true }));
  }

  private drawToolPreview(sn: Snap) {
    this.clearPreview();
    this.drawSnapMarker(sn);
    const c = this.clicks;
    const n = this.host.numeric;
    const live: Record<string, number> = { x: sn.pt[0], y: sn.pt[1] };
    const col = COLORS.preview;
    if (c.length >= 1) {
      const a = c[0].pt, b = sn.pt;
      switch (this.tool) {
        case 'line': {
          const st = c[c.length - 1].pt;
          this.preview.add(polyLine([st, b], col));
          const d = sub(b, st);
          live.len = len(d);
          live.ang = normAngle(Math.atan2(d[1], d[0])) * 180 / Math.PI;
          break;
        }
        case 'rect': {
          this.preview.add(polyLine([a, [b[0], a[1]], b, [a[0], b[1]], a], col));
          live.w = Math.abs(b[0] - a[0]);
          live.h = Math.abs(b[1] - a[1]);
          break;
        }
        case 'centerRect': {
          const h = sub(b, a);
          const p0 = sub(a, h);
          this.preview.add(polyLine([p0, [b[0], p0[1]], b, [p0[0], b[1]], p0], col));
          this.preview.add(polyLine([p0, b], 0x64748b, { dashed: true }));
          live.w = Math.abs(h[0]) * 2;
          live.h = Math.abs(h[1]) * 2;
          break;
        }
        case 'circle': {
          const r = dist(a, b);
          this.preview.add(polyLine(circlePts(a, r), col));
          this.preview.add(polyLine([a, b], 0x64748b, { dashed: true }));
          live.d = r * 2;
          break;
        }
        case 'arc': {
          if (c.length === 1) {
            this.preview.add(polyLine([a, b], 0x64748b, { dashed: true }));
            this.preview.add(polyLine(circlePts(a, dist(a, b)), 0x475569, { dashed: true }));
            live.r = dist(a, b);
          } else {
            const st = c[1].pt;
            const r = dist(a, st);
            const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
            if (!n.get('ang')?.locked) {
              let dd = ang - this.arcLastAng;
              while (dd > Math.PI) dd -= TAU;
              while (dd < -Math.PI) dd += TAU;
              this.arcAcc = Math.max(-TAU + 1e-3, Math.min(TAU - 1e-3, this.arcAcc + dd));
              this.arcLastAng = ang;
            }
            const a0 = Math.atan2(st[1] - a[1], st[0] - a[0]);
            const arc: Vec2[] = [];
            for (let i = 0; i <= 64; i++) {
              const t = a0 + (this.arcAcc * i) / 64;
              arc.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
            }
            this.preview.add(polyLine(arc, col));
            this.preview.add(polyLine([a, st], 0x64748b, { dashed: true }));
            live.ang = Math.abs(this.arcAcc) * 180 / Math.PI;
          }
          break;
        }
        case 'arc3': {
          if (c.length === 1) this.preview.add(polyLine([a, b], 0x64748b, { dashed: true }));
          else {
            const circ = circumcircle(c[0].pt, c[1].pt, b);
            if (circ) {
              const s0 = c[0].pt, e0 = c[1].pt;
              const cr = cross(sub(b, s0), sub(e0, s0));
              const [S, E] = cr > 0 ? [s0, e0] : [e0, s0];
              const as = Math.atan2(S[1] - circ.c[1], S[0] - circ.c[0]);
              const sw = normAngle(Math.atan2(E[1] - circ.c[1], E[0] - circ.c[0]) - as);
              const arc: Vec2[] = [];
              for (let i = 0; i <= 64; i++) arc.push([circ.c[0] + circ.r * Math.cos(as + (sw * i) / 64), circ.c[1] + circ.r * Math.sin(as + (sw * i) / 64)]);
              this.preview.add(polyLine(arc, col));
            }
          }
          break;
        }
        case 'polygon': {
          const nS = Math.max(3, Math.min(64, Math.round(n.get('n')?.value || this.polygonSides)));
          const R = dist(a, b);
          const a0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const poly: Vec2[] = [];
          for (let i = 0; i <= nS; i++) poly.push([a[0] + R * Math.cos(a0 + (i / nS) * TAU), a[1] + R * Math.sin(a0 + (i / nS) * TAU)]);
          this.preview.add(polyLine(poly, col));
          this.preview.add(polyLine(circlePts(a, R), 0x475569, { dashed: true }));
          live.r = R;
          break;
        }
      }
    }
    n.setLive(live);
  }

  // ================================================================ dimension tool

  private kindOf(id: string): 'point' | 'line' | 'circle' | 'arc' | null {
    const s = this.sketch;
    if (s.points.some((p) => p.id === id)) return 'point';
    return (s.curves.find((c) => c.id === id)?.type as any) ?? null;
  }

  /** Builds the dimension that would be created for the current refs and label position. */
  private pendingDimension(labelPos: Vec2): SketchConstraint | null {
    const r = this.dimRefs;
    const s = this.sketch;
    const pts = pointMap(s);
    const curves = new Map(s.curves.map((c) => [c.id, c]));
    const k = r.map((id) => this.kindOf(id));
    let c: SketchConstraint | null = null;
    const hv = (a: Vec2, b: Vec2, refsAligned: string[], pa: string, pb: string): SketchConstraint => {
      const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      const inX = labelPos[0] >= x0 && labelPos[0] <= x1;
      const inY = labelPos[1] >= y0 && labelPos[1] <= y1;
      const mid = scale(add(a, b), 0.5);
      if (inX && !inY && x1 - x0 > 1e-6) {
        const [p, q] = a[0] <= b[0] ? [pa, pb] : [pb, pa];
        return { id: '', type: 'hdistance', refs: [p, q], offset: sub(labelPos, mid) };
      }
      if (inY && !inX && y1 - y0 > 1e-6) {
        const [p, q] = a[1] <= b[1] ? [pa, pb] : [pb, pa];
        return { id: '', type: 'vdistance', refs: [p, q], offset: sub(labelPos, mid) };
      }
      return { id: '', type: 'distance', refs: refsAligned, offset: sub(labelPos, mid) };
    };
    if (r.length === 1) {
      if (k[0] === 'circle') c = { id: '', type: 'diameter', refs: r, offset: sub(labelPos, P(pts.get((curves.get(r[0]) as any).c)!)) };
      else if (k[0] === 'arc') c = { id: '', type: 'radius', refs: r, offset: sub(labelPos, P(pts.get((curves.get(r[0]) as any).c)!)) };
      else if (k[0] === 'line') {
        const l = curves.get(r[0]) as any;
        const a = P(pts.get(l.p1)!), b = P(pts.get(l.p2)!);
        const horizontalish = Math.abs(a[1] - b[1]) < 1e-6 || Math.abs(a[0] - b[0]) < 1e-6;
        c = horizontalish ? { id: '', type: 'distance', refs: r, offset: sub(labelPos, scale(add(a, b), 0.5)) } : hv(a, b, r, l.p1, l.p2);
      }
    } else if (r.length === 2) {
      if (k[0] === 'point' && k[1] === 'point') c = hv(P(pts.get(r[0])!), P(pts.get(r[1])!), r, r[0], r[1]);
      else if ((k[0] === 'point' && k[1] === 'line') || (k[0] === 'line' && k[1] === 'point')) {
        const [p, l] = k[0] === 'point' ? r : [r[1], r[0]];
        const lc = curves.get(l) as any;
        const la = P(pts.get(lc.p1)!), lb = P(pts.get(lc.p2)!), pp = P(pts.get(p)!);
        const d = norm(sub(lb, la));
        const t = (pp[0] - la[0]) * d[0] + (pp[1] - la[1]) * d[1];
        const foot = add(la, scale(d, t));
        c = { id: '', type: 'distance', refs: [p, l], offset: sub(labelPos, scale(add(pp, foot), 0.5)) };
      } else if (k[0] === 'line' && k[1] === 'line') {
        const l1 = curves.get(r[0]) as any, l2 = curves.get(r[1]) as any;
        const a1 = P(pts.get(l1.p1)!), a2 = P(pts.get(l1.p2)!), b1 = P(pts.get(l2.p1)!), b2 = P(pts.get(l2.p2)!);
        const d1 = norm(sub(a2, a1)), d2 = norm(sub(b2, b1));
        if (Math.abs(cross(d1, d2)) < 1e-6) {
          // parallel lines: distance from point to line
          const t = (b1[0] - a1[0]) * d1[0] + (b1[1] - a1[1]) * d1[1];
          const foot = add(a1, scale(d1, t));
          c = { id: '', type: 'distance', refs: [l2.p1, r[0]], offset: sub(labelPos, scale(add(b1, foot), 0.5)) };
        } else {
          const den = cross(d1, d2);
          const t = cross(sub(b1, a1), d2) / den;
          const x = add(a1, scale(d1, t));
          c = { id: '', type: 'angle', refs: r, offset: sub(labelPos, x) };
        }
      } else if ((k[0] === 'circle' || k[0] === 'arc') && (k[1] === 'circle' || k[1] === 'arc')) {
        const c1 = curves.get(r[0]) as any, c2 = curves.get(r[1]) as any;
        c = hv(P(pts.get(c1.c)!), P(pts.get(c2.c)!), [c1.c, c2.c], c1.c, c2.c);
      } else if ((k[0] === 'circle' || k[0] === 'arc') && k[1] === 'point') {
        c = hv(P(pts.get((curves.get(r[0]) as any).c)!), P(pts.get(r[1])!), [(curves.get(r[0]) as any).c, r[1]], (curves.get(r[0]) as any).c, r[1]);
      } else if (k[0] === 'point' && (k[1] === 'circle' || k[1] === 'arc')) {
        c = hv(P(pts.get(r[0])!), P(pts.get((curves.get(r[1]) as any).c)!), [r[0], (curves.get(r[1]) as any).c], r[0], (curves.get(r[1]) as any).c);
      }
    }
    if (c) c.value = fmt(Math.abs(measure(c, pts, curves)), 4);
    return c;
  }

  private dimensionClick(m: Vec2, ev: PointerEvent) {
    const hit = this.hitTest(m);
    const r = this.dimRefs;
    const ready = r.length === 2 || (r.length === 1 && ['circle', 'arc'].includes(this.kindOf(r[0]) ?? ''));
    if (hit && !ready && !r.includes(hit)) {
      r.push(hit);
      this.sel = new Set(r);
      this.rebuild();
      return;
    }
    if (r.length === 0) return;
    // a single point dimensions against the sketch origin
    if (r.length === 1 && this.kindOf(r[0]) === 'point' && r[0] !== ORIGIN_ID) r.push(ORIGIN_ID);
    const dim = this.pendingDimension(m);
    if (!dim) {
      this.host.toast('Cannot dimension this combination', 'err');
      this.dimRefs = [];
      return;
    }
    let newId = '';
    this.edit('sketch', (s) => {
      dim.id = newId = this.nid('c');
      s.constraints.push(dim);
    });
    this.dimRefs = [];
    this.sel = new Set([newId]);
    this.clearPreview();
    this.rebuild();
    this.host.onSelection();
    void ev;
    this.openDimEditor(newId);
  }

  private drawDimPreview(m: Vec2) {
    this.clearPreview();
    if (!this.dimRefs.length) return;
    const single = this.dimRefs.length === 1 && this.kindOf(this.dimRefs[0]) === 'point' && this.dimRefs[0] !== ORIGIN_ID;
    if (single) this.dimRefs.push(ORIGIN_ID);
    const d = this.pendingDimension(m);
    if (single) this.dimRefs.pop();
    if (!d) return;
    const s = this.sketch;
    const lay = dimensionLayout(d, pointMap(s), new Map(s.curves.map((c) => [c.id, c])));
    if (!lay) return;
    for (const seg of lay.segments) this.preview.add(polyLine(seg, COLORS.dim, { opacity: 0.7 }));
    this.preview.add(pointsObject([{ p: lay.label, color: COLORS.dim }], 6));
  }

  // ================================================================ fillet

  private filletClick(m: Vec2) {
    const nr = this.host.numeric.get('r');
    if (nr?.locked) this.filletRadius = nr.value;
    const hit = this.hitTest(m);
    const s = this.sketch;
    const p = s.points.find((x) => x.id === hit);
    if (!p) return this.host.toast('Click on a corner point', 'err');
    const lines = s.curves.filter((c): c is Extract<SketchCurve, { type: 'line' }> => c.type === 'line' && !c.construction && (c.p1 === p.id || c.p2 === p.id));
    if (lines.length !== 2) return this.host.toast('Fillet needs exactly two lines meeting at the point', 'err');
    const r = this.filletRadius;
    const pts = pointMap(s);
    const other = (l: (typeof lines)[0]) => P(pts.get(l.p1 === p.id ? l.p2 : l.p1)!);
    const Pp = P(p);
    const u1 = norm(sub(other(lines[0]), Pp)), u2 = norm(sub(other(lines[1]), Pp));
    const cosA = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const half = Math.acos(cosA) / 2;
    if (half < 1e-3 || Math.abs(half - Math.PI / 2) < 1e-3) return this.host.toast('Lines are collinear', 'err');
    const t = r / Math.tan(half);
    if (t >= dist(Pp, other(lines[0])) || t >= dist(Pp, other(lines[1]))) return this.host.toast('Radius too large for these lines', 'err');
    const T1 = add(Pp, scale(u1, t)), T2 = add(Pp, scale(u2, t));
    const C = add(Pp, scale(norm(add(u1, u2)), r / Math.sin(half)));
    this.edit('sketch', (sk) => {
      const t1 = this.nid('p'), t2 = this.nid('p'), cc = this.nid('p');
      sk.points.push({ id: t1, x: T1[0], y: T1[1] }, { id: t2, x: T2[0], y: T2[1] }, { id: cc, x: C[0], y: C[1] });
      const L = lines.map((l) => sk.curves.find((c) => c.id === l.id) as typeof l);
      if (L[0].p1 === p.id) L[0].p1 = t1; else L[0].p2 = t1;
      if (L[1].p1 === p.id) L[1].p1 = t2; else L[1].p2 = t2;
      const crs = cross(sub(T1, C), sub(T2, C));
      const [S, E] = crs > 0 ? [t1, t2] : [t2, t1];
      const aid = this.nid('a');
      sk.curves.push({ id: aid, type: 'arc', c: cc, s: S, e: E, r });
      this.con(sk, 'tangent', [L[0].id, aid]);
      this.con(sk, 'tangent', [L[1].id, aid]);
      this.con(sk, 'radius', [aid], r);
      // remove the old corner if it is no longer used
      const used = sk.curves.some((c) => (c.type === 'line' ? [c.p1, c.p2] : c.type === 'circle' ? [c.c] : [c.c, c.s, c.e]).includes(p.id));
      if (!used && p.id !== ORIGIN_ID) {
        sk.points = sk.points.filter((x) => x.id !== p.id);
        sk.constraints = sk.constraints.filter((c) => !c.refs.includes(p.id));
      }
    });
    this.rebuild();
  }

  // ================================================================ project

  computeRefs() {
    const segs: Vec2[][] = [];
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (const mesh of this.host.vp.allBodyMeshes()) {
      const pos = (mesh.children[0] as THREE.LineSegments).geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 2) {
        v.fromBufferAttribute(pos, i);
        w.fromBufferAttribute(pos, i + 1);
        const a = toLocal(this.frame, [v.x, v.y, v.z]), b = toLocal(this.frame, [w.x, w.y, w.z]);
        if (Math.abs(a[2]) < 1e-3 && Math.abs(b[2]) < 1e-3) segs.push([[a[0], a[1]], [b[0], b[1]]]);
      }
    }
    this.refSegments = segs;
  }

  private nearestRef(m: Vec2): Vec2[] | null {
    const tol = this.pixel() * 8;
    let best: Vec2[] | null = null, bd = tol;
    for (const s of this.refSegments) {
      const d = closestOnSegment(m, s[0], s[1]).d;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  private drawProjectPreview(m: Vec2) {
    this.clearPreview();
    const seg = this.nearestRef(m);
    if (seg) this.preview.add(polyLine(seg, COLORS.hover));
  }

  private projectClick(m: Vec2) {
    const seg = this.nearestRef(m);
    if (!seg) return;
    // collect the connected chain of reference segments on the same face outline? keep single segment.
    this.edit('sketch', (s) => {
      const find = (q: Vec2) => s.points.find((p) => dist(P(p), q) < 1e-6)?.id;
      const mk = (q: Vec2) => {
        const ex = find(q);
        if (ex) return ex;
        const id = this.nid('p');
        s.points.push({ id, x: q[0], y: q[1], fixed: true });
        return id;
      };
      const a = mk(seg[0]), b = mk(seg[1]);
      if (a !== b) s.curves.push({ id: this.nid('l'), type: 'line', p1: a, p2: b });
    });
    this.rebuild();
  }

  // ================================================================ constraint commands

  applyConstraint(type: ConstraintType | 'construction'): void {
    const s = this.sketch;
    const ids = [...this.sel];
    const kinds = ids.map((id) => this.kindOf(id));
    const ptsSel = ids.filter((_, i) => kinds[i] === 'point');
    const lines = ids.filter((_, i) => kinds[i] === 'line');
    const rounds = ids.filter((_, i) => kinds[i] === 'circle' || kinds[i] === 'arc');
    const fail = (msg: string) => this.host.toast(msg, 'err');
    const add: [ConstraintType, string[]][] = [];

    switch (type) {
      case 'construction':
        if (!lines.length && !rounds.length) return fail('Select curves to toggle construction');
        this.edit('sketch', (sk) => {
          for (const c of sk.curves) if (this.sel.has(c.id)) c.construction = !c.construction;
        });
        return this.rebuild();
      case 'horizontal':
      case 'vertical':
        if (lines.length) lines.forEach((l) => add.push([type, [l]]));
        else if (ptsSel.length === 2) add.push([type, ptsSel]);
        else return fail('Select one or more lines, or two points');
        break;
      case 'parallel':
      case 'perpendicular':
        if (lines.length < 2) return fail('Select two lines');
        for (let i = 1; i < lines.length; i++) add.push([type, [lines[0], lines[i]]]);
        break;
      case 'equal':
        if (lines.length >= 2) for (let i = 1; i < lines.length; i++) add.push(['equal', [lines[0], lines[i]]]);
        else if (rounds.length >= 2) for (let i = 1; i < rounds.length; i++) add.push(['equal', [rounds[0], rounds[i]]]);
        else return fail('Select two lines or two circles/arcs');
        break;
      case 'tangent':
        if (lines.length === 1 && rounds.length === 1) add.push(['tangent', [lines[0], rounds[0]]]);
        else if (rounds.length === 2) add.push(['tangent', rounds]);
        else return fail('Select a line and a circle/arc, or two circles/arcs');
        break;
      case 'coincident':
        if (ptsSel.length === 2 && ids.length === 2) add.push(['coincident', ptsSel]);
        else if (ptsSel.length === 1 && ids.length === 2) add.push(['pointOnCurve', [ptsSel[0], ids.find((x) => x !== ptsSel[0])!]]);
        else return fail('Select two points, or a point and a curve');
        break;
      case 'midpoint':
        if (ptsSel.length === 1 && lines.length === 1) add.push(['midpoint', [ptsSel[0], lines[0]]]);
        else return fail('Select a point and a line');
        break;
      case 'symmetric':
        if (ptsSel.length === 2 && lines.length === 1) add.push(['symmetric', [ptsSel[0], ptsSel[1], lines[0]]]);
        else return fail('Select two points and a symmetry line');
        break;
      case 'concentric':
        if (rounds.length === 2) add.push(['concentric', rounds]);
        else return fail('Select two circles/arcs');
        break;
      case 'fix': {
        const pts = new Set(ptsSel);
        for (const id of [...lines, ...rounds]) {
          const c = s.curves.find((x) => x.id === id)!;
          (c.type === 'line' ? [c.p1, c.p2] : c.type === 'circle' ? [c.c] : [c.c, c.s, c.e]).forEach((p) => pts.add(p));
        }
        pts.delete(ORIGIN_ID);
        if (!pts.size) return fail('Select points or curves to fix');
        // toggle: if all fixed → unfix
        const existing = s.constraints.filter((c) => c.type === 'fix' && pts.has(c.refs[0]));
        if (existing.length === pts.size) {
          this.edit('sketch', (sk) => {
            sk.constraints = sk.constraints.filter((c) => !(c.type === 'fix' && pts.has(c.refs[0])));
          });
          return this.rebuild();
        }
        pts.forEach((p) => { if (!existing.some((e) => e.refs[0] === p)) add.push(['fix', [p]]); });
        break;
      }
      default:
        return;
    }
    const added: string[] = [];
    this.edit('sketch', (sk) => {
      for (const [t, refs] of add) added.push(this.con(sk, t, refs).id);
    });
    const r = this.lastSolve;
    if (r && r.ok && added.some((id) => r.redundant.includes(id)) && !r.conflicting.length) {
      this.host.toast('That constraint is already implied by existing ones — undone', 'err');
      this.host.store.undo();
      this.solve();
    } else if (r && (!r.ok || r.conflicting.length)) {
      this.host.toast('Constraint conflicts with existing constraints — undone', 'err');
      this.host.store.undo();
      this.solve();
    }
    this.rebuild();
  }

  deleteSelection() {
    if (!this.sel.size) return;
    const del = new Set(this.sel);
    del.delete(ORIGIN_ID);
    this.edit('sketch', (s) => {
      // curves using deleted points
      for (const c of s.curves) {
        const ps = c.type === 'line' ? [c.p1, c.p2] : c.type === 'circle' ? [c.c] : [c.c, c.s, c.e];
        if (ps.some((p) => del.has(p))) del.add(c.id);
      }
      const removedCurves = s.curves.filter((c) => del.has(c.id));
      s.curves = s.curves.filter((c) => !del.has(c.id));
      // orphaned points of removed curves
      const used = new Set<string>();
      for (const c of s.curves) (c.type === 'line' ? [c.p1, c.p2] : c.type === 'circle' ? [c.c] : [c.c, c.s, c.e]).forEach((p) => used.add(p));
      for (const c of removedCurves)
        for (const p of c.type === 'line' ? [c.p1, c.p2] : c.type === 'circle' ? [c.c] : [c.c, c.s, c.e])
          if (!used.has(p) && p !== ORIGIN_ID) del.add(p);
      s.points = s.points.filter((p) => !del.has(p.id));
      s.constraints = s.constraints.filter((c) => !del.has(c.id) && !c.refs.some((r) => del.has(r)));
    });
    this.sel.clear();
    this.host.onSelection();
    this.rebuild();
  }

  selectAll() {
    const s = this.sketch;
    this.sel = new Set([...s.curves.map((c) => c.id), ...s.points.filter((p) => p.id !== ORIGIN_ID).map((p) => p.id)]);
    this.host.onSelection();
    this.rebuild();
  }

  selectedConstraint(): SketchConstraint | null {
    if (this.sel.size !== 1) return null;
    const id = [...this.sel][0];
    return this.sketch.constraints.find((c) => c.id === id) ?? null;
  }

  setConstraintValue(id: string, value: string): boolean {
    const r = this.host.scope().tryEval(value);
    if (r.error !== undefined) {
      this.host.toast(r.error, 'err');
      return false;
    }
    const c = this.sketch.constraints.find((x) => x.id === id);
    if (c && ['radius', 'diameter', 'distance'].includes(c.type) && r.value! <= 0) {
      this.host.toast('Value must be greater than 0', 'err');
      return false;
    }
    this.edit('sketch', (s) => {
      const c = s.constraints.find((x) => x.id === id);
      if (c) c.value = value.trim();
    });
    if (this.lastSolve && !this.lastSolve.ok) {
      this.host.toast('Sketch cannot satisfy this value — reverted', 'err');
      this.host.store.undo();
      this.solve();
    }
    this.rebuild();
    return true;
  }

  toggleReference(id: string) {
    this.edit('sketch', (s) => {
      const c = s.constraints.find((x) => x.id === id);
      if (c) c.reference = !c.reference;
    });
    this.rebuild();
  }

  // ================================================================ dimension inline editor

  openDimEditor(id: string) {
    this.closeDimEditor(false);
    const c = this.sketch.constraints.find((x) => x.id === id);
    if (!c) return;
    const lab = this.labels.find((l) => l.el.dataset.id === id);
    const inp = document.createElement('input');
    inp.className = 'dim-edit';
    inp.value = c.value ?? '';
    inp.dataset.id = id;
    if (lab) {
      inp.style.left = lab.el.style.left;
      inp.style.top = lab.el.style.top;
    }
    this.host.vp.labelLayer.appendChild(inp);
    inp.style.pointerEvents = 'auto';
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.closeDimEditor(true);
      if (e.key === 'Escape') this.closeDimEditor(false);
    });
    inp.addEventListener('blur', () => setTimeout(() => this.closeDimEditor(true), 0));
    this.dimEditor = inp;
  }

  private closeDimEditor(commit: boolean) {
    const inp = this.dimEditor;
    if (!inp) return;
    this.dimEditor = null;
    inp.remove();
    if (commit) {
      const c = this.sketch.constraints.find((x) => x.id === inp.dataset.id);
      if (c && inp.value.trim() && inp.value.trim() !== c.value) this.setConstraintValue(c.id, inp.value);
    }
  }

  // ================================================================ rendering

  private clearLabels() {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
  }

  rebuild() {
    if (!this.alive) return;
    const s = this.sketch;
    if (!s) return;
    this.group.traverse((o) => (o as any).geometry?.dispose?.());
    this.group.clear();
    this.clearLabels();
    const pts = pointMap(s);
    const curves = new Map(s.curves.map((c) => [c.id, c]));
    const full = this.lastSolve?.ok && this.lastSolve.dof === 0;
    const conflicts = new Set([...(this.lastSolve?.conflicting ?? []), ...(this.lastSolve?.redundant ?? [])]);
    const base = full ? COLORS.full : COLORS.under;

    // reference (projected) edges
    for (const seg of this.refSegments) this.group.add(polyLine(seg, COLORS.ref, { opacity: 0.6 }));

    // profile fill
    try {
      const { loops } = findProfiles(s);
      if (loops.length) {
        const wasm = kernel();
        const cs = new wasm.CrossSection(loops as any, 'EvenOdd');
        const polys = cs.toPolygons();
        cs.delete();
        const flat = polys.flat();
        const tris = wasm.triangulate(polys as any);
        const pos = new Float32Array(tris.length * 9);
        tris.forEach((t, i) => t.forEach((vi, j) => pos.set([flat[vi][0], flat[vi][1], 0], i * 9 + j * 3)));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COLORS.fill, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
        fill.renderOrder = 15;
        this.group.add(fill);
      }
    } catch {
      /* ignore fill errors */
    }

    // curves
    for (const c of s.curves) {
      const sel = this.sel.has(c.id), hov = this.hover === c.id;
      const color = sel ? COLORS.selected : hov ? COLORS.hover : c.construction ? COLORS.construction : base;
      this.group.add(polyLine(curvePoly(c, pts), color, { dashed: !!c.construction }));
    }

    // points
    const items = s.points.map((p) => ({
      p: P(p),
      color: this.sel.has(p.id) ? COLORS.selected : this.hover === p.id ? COLORS.hover : p.id === ORIGIN_ID ? 0xef4444 : p.fixed ? 0xa78bfa : base,
    }));
    this.group.add(pointsObject(items, 7));

    // constraints & dimensions
    const scope = this.host.scope();
    const perEntityCount = new Map<string, number>();
    for (const c of s.constraints) {
      if (DIMENSION_TYPES.includes(c.type)) {
        let txt: string | undefined;
        const r = scope.tryEval(c.value ?? '0');
        const isExpr = c.value !== undefined && isNaN(Number(c.value));
        if (c.reference) txt = undefined;
        else if (r.value !== undefined) txt = (isExpr ? `${c.value} = ` : '') + fmt(Math.abs(r.value), 2);
        const lay = dimensionLayout(c, pts, curves, txt);
        if (!lay) continue;
        const sel = this.sel.has(c.id);
        for (const seg of lay.segments) this.group.add(polyLine(seg, sel ? COLORS.selected : c.reference ? 0x94a3b8 : COLORS.dim, { opacity: 0.9 }));
        const el = document.createElement('div');
        el.className = 'dim-label' + (sel ? ' selected' : '') + (conflicts.has(c.id) ? ' conflict' : '') + (c.reference ? ' ref' : '');
        el.textContent = c.reference ? `(${lay.text})` : lay.text;
        el.dataset.id = c.id;
        this.attachLabelEvents(el, c);
        this.host.vp.labelLayer.appendChild(el);
        this.labels.push({ el, at: lay.label });
      } else {
        const sym = BADGE[c.type];
        if (!sym) continue;
        const targets = c.type === 'symmetric' ? [c.refs[2]] : c.type === 'coincident' || c.type === 'pointOnCurve' || c.type === 'midpoint' || c.type === 'fix' ? [c.refs[0]] : c.refs;
        for (const t of targets) {
          const idx = perEntityCount.get(t) ?? 0;
          perEntityCount.set(t, idx + 1);
          const at = badgeAnchor(t, pts, curves, idx);
          if (!at) continue;
          const el = document.createElement('div');
          el.className = 'con-label' + (this.sel.has(c.id) ? ' selected' : '');
          if (conflicts.has(c.id)) el.style.color = '#f87171';
          el.textContent = sym;
          el.title = c.type;
          el.dataset.id = c.id;
          const off = pts.has(t) ? [6, 6] : [0, 0];
          el.style.marginLeft = `${off[0] + idx * 4}px`;
          el.style.marginTop = `${off[1] - 10}px`;
          this.attachLabelEvents(el, c);
          this.host.vp.labelLayer.appendChild(el);
          this.labels.push({ el, at });
        }
      }
    }
    this.frameHook();
  }

  private attachLabelEvents(el: HTMLElement, c: SketchConstraint) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.shiftKey || e.ctrlKey) {
        if (this.sel.has(c.id)) this.sel.delete(c.id);
        else this.sel.add(c.id);
      } else {
        this.sel = new Set([c.id]);
      }
      this.host.onSelection();
      if (DIMENSION_TYPES.includes(c.type)) {
        const m = this.host.vp.planePoint(e, this.frame);
        if (m) {
          this.host.store.beginGesture();
          this.drag = { kind: 'label', id: c.id, start: m, orig: c.offset ?? [0, 0] };
          const up = () => {
            window.removeEventListener('pointerup', up);
            this.onPointerUp(e);
          };
          window.addEventListener('pointerup', up);
        }
      }
      this.rebuild();
    });
    el.addEventListener('pointermove', (e) => this.onPointerMove(e as PointerEvent));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (DIMENSION_TYPES.includes(c.type)) this.openDimEditor(c.id);
    });
  }

  /** Info for the status bar. */
  info() {
    const s = this.sketch;
    return { points: s.points.length, curves: s.curves.length, constraints: s.constraints.length };
  }

  get mouseLocal(): Vec2 {
    return this.mouse;
  }

  arcInfo(curveId: string) {
    const s = this.sketch;
    const c = s.curves.find((x) => x.id === curveId);
    if (c?.type !== 'arc') return null;
    return arcAngles(c, pointMap(s));
  }
}

// ---------------------------------------------------------------- helpers

function cross(a: Vec2, b: Vec2) {
  return a[0] * b[1] - a[1] * b[0];
}

function circlePts(c: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= 96; i++) out.push([c[0] + r * Math.cos((i / 96) * TAU), c[1] + r * Math.sin((i / 96) * TAU)]);
  return out;
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: dist([ux, uy], a) };
}

export type { SketchPoint };
