// Application controller: wires document, kernel, viewport, sketch editor and UI.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { DocStore, createEmptyDocument, clone } from './model/document';
import type { BodyOp, Feature, OriginPlane, SketchFeature, Vec3 } from './model/types';
import { ParamScope, fmt } from './model/expr';
import { regenerate, type RegenResult } from './kernel/regenerate';
import { Viewport } from './view/viewport';
import { ViewCube } from './view/viewcube';
import { SketchEditor, type SketchTool } from './sketch/editor';
import { frameFromPlane, ORIGIN_ID, toLocal } from './sketch/geom';
import { NumericInput } from './ui/numericInput';
import { icon } from './ui/icons';
import { renderTree } from './ui/tree';
import { renderProps } from './ui/props';
import { renderParams } from './ui/params';
import { download, exportMesh, openProjectFile, saveProject, sketchToDXF, sketchToSVG } from './io/files';

type Mode = 'model' | 'sketch' | 'pickPlane' | 'measure';
type RibbonTab = 'file' | 'model' | 'view';

interface Btn {
  id: string;
  label: string;
  icon: string;
  run: () => void;
  title?: string;
  cls?: string;
  active?: () => boolean;
  enabled?: () => boolean;
}

export class App {
  store: DocStore;
  vp: Viewport;
  numeric: NumericInput;
  result: RegenResult | null = null;
  editor: SketchEditor | null = null;
  mode: Mode = 'model';
  tab: RibbonTab = 'model';
  selectedFeature: string | null = null;
  settings = { snapGrid: true, gridStep: 1, snapObjects: true };
  showSketches = true;
  private measurePts: THREE.Vector3[] = [];
  private measureGroup = new THREE.Group();
  private measureLabel: HTMLDivElement | null = null;
  private gizmo: TransformControls | null = null;
  private gizmoTarget = new THREE.Object3D();
  private gizmoFeature: string | null = null;
  private regenQueued = false;
  private statusMsg = '';

  constructor() {
    const restored = DocStore.loadAutosave();
    this.store = new DocStore(restored ?? createEmptyDocument());
    this.vp = new Viewport(document.getElementById('canvas-host')!);
    new ViewCube(document.getElementById('viewcube-host')!, this.vp);
    this.numeric = new NumericInput(document.getElementById('numeric-input')!, (s) => this.scope().tryEval(s).value);
    this.vp.overlayGroup.add(this.measureGroup);
    this.vp.scene.add(this.gizmoTarget);

    this.store.onChange((reason) => {
      if (reason === 'sketch-drag') {
        this.editor?.rebuild();
        this.renderStatus();
        return;
      }
      if (reason === 'undo' || reason === 'redo' || reason === 'replace') {
        if (this.editor && !this.store.sketch(this.editor.id)) this.exitSketch();
        if (this.selectedFeature && !this.store.feature(this.selectedFeature)) this.selectedFeature = null;
      }
      this.queueRegen();
    });

    this.bindDom();
    this.renderRibbon();
    this.regen();
    this.vp.fitAll();
    if (restored && restored.features.length) this.toast('Restored your last session (autosave)', 'ok');
  }

  scope(): ParamScope {
    return this.result?.scope ?? new ParamScope(this.store.doc.params);
  }

  // ============================================================ regen

  queueRegen() {
    if (this.regenQueued) return;
    this.regenQueued = true;
    requestAnimationFrame(() => {
      this.regenQueued = false;
      this.regen();
    });
  }

  regen() {
    try {
      this.result = regenerate(this.store.doc);
    } catch (e) {
      this.toast(`Regeneration failed: ${(e as Error).message}`, 'err');
      return;
    }
    const r = this.result;
    this.vp.setBodies(r.bodies, new Set(this.store.doc.hiddenBodies));
    // drop selections of bodies that no longer exist
    for (const id of [...this.vp.selectedBodies]) if (!r.bodies.some((b) => b.id === id)) this.vp.selectedBodies.delete(id);
    this.vp.refreshBodyColors();
    if (this.mode === 'sketch') this.vp.setBodyOpacity(0.35);
    this.refreshSketchDisplay();
    if (this.editor) {
      this.editor.rebuild();
      this.renderStatus();
    }
    this.renderPanels();
    this.updateGizmo();
  }

  refreshSketchDisplay() {
    const r = this.result;
    if (!r) return;
    const list: { s: SketchFeature; frame: any }[] = [];
    for (const f of this.store.activeFeatures()) {
      if (f.type !== 'sketch' || f.suppressed || !r.frames.has(f.id)) continue;
      if (this.editor?.id === f.id) continue;
      if (!this.showSketches || f.visible === false) continue;
      list.push({ s: f, frame: r.frames.get(f.id)! });
    }
    this.vp.setSketches(list);
  }

  renderPanels() {
    renderTree(this, document.getElementById('tree-panel')!);
    renderProps(this, document.getElementById('props-panel')!);
    renderParams(this, document.getElementById('params-panel')!);
    this.renderRibbonState();
    this.renderStatus();
    const t = document.getElementById('doc-title')!;
    t.textContent = this.store.doc.name + (this.store.dirty ? ' •' : '');
  }

  // ============================================================ DOM wiring

  private bindDom() {
    const canvas = this.vp.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.editor?.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.store.dirty && this.store.doc.features.length) e.preventDefault();
    });

    document.querySelectorAll<HTMLButtonElement>('.panel-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('.panel-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        document.getElementById('tree-panel')!.classList.toggle('hidden', b.dataset.tab !== 'tree');
        document.getElementById('params-panel')!.classList.toggle('hidden', b.dataset.tab !== 'params');
      }),
    );
    document.getElementById('doc-title')!.addEventListener('click', () => {
      const n = prompt('Document name', this.store.doc.name);
      if (n && n.trim()) this.store.commit('rename', (d) => (d.name = n.trim()));
    });
    document.getElementById('doc-title')!.style.cursor = 'pointer';
    document.getElementById('doc-title')!.title = 'Click to rename';

    const vb = document.getElementById('view-buttons')!;
    vb.innerHTML = `<div class="row"><button data-v="iso">Home</button><button data-v="fit">Fit</button></div>
      <div class="row"><button data-v="proj">${'Ortho'}</button><button data-v="lookat" title="Look at sketch plane">Look at</button></div>`;
    vb.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).dataset.v;
      if (v === 'iso') this.view('iso');
      if (v === 'fit') this.vp.fitAll();
      if (v === 'proj') this.toggleProjection();
      if (v === 'lookat') this.lookAtSketch();
    });

    // gizmo
    this.gizmo = new TransformControls(this.vp.camera, canvas);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.vp.controls.enabled = !e.value;
      if (e.value) this.store.beginGesture();
      else this.store.endGesture('gizmo');
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoMove());
    this.vp.scene.add(this.gizmo.getHelper());
    this.gizmo.enabled = false;
    this.gizmo.getHelper().visible = false;
  }

  // ============================================================ ribbon

  private ribbonButtons(): { group: string; items: Btn[] }[] {
    if (this.mode === 'sketch') {
      const t = (id: SketchTool, label: string, ic = id as string, title?: string): Btn => ({
        id, label, icon: ic, title, run: () => this.editor?.setTool(id), active: () => this.editor?.tool === id,
      });
      const c = (id: any, label: string, title?: string): Btn => ({ id, label, icon: id, title, run: () => this.editor?.applyConstraint(id) });
      return [
        { group: 'Create', items: [t('select', 'Select', 'select', 'Select (Esc)'), t('line', 'Line', 'line', 'Line (L)'), t('rect', 'Rectangle', 'rect', 'Rectangle (R)'), t('centerRect', 'Center Rect', 'centerRect'), t('circle', 'Circle', 'circle', 'Circle (C)'), t('arc', 'Arc', 'arc', 'Center arc (A)'), t('arc3', '3-Pt Arc', 'arc3'), t('polygon', 'Polygon', 'polygon'), t('point', 'Point', 'point', 'Point (P)')] },
        { group: 'Modify', items: [t('fillet', 'Fillet', 'fillet'), t('project', 'Project', 'project', 'Project model edges'), c('construction', 'Construct', 'Toggle construction (X)'), { id: 'del', label: 'Delete', icon: 'delete', run: () => this.editor?.deleteSelection(), title: 'Delete (Del)' }] },
        { group: 'Constrain', items: [t('dimension', 'Dimension', 'dimension', 'Dimension (D)'), c('coincident', 'Coincident'), c('horizontal', 'Horizontal', 'Horizontal (H)'), c('vertical', 'Vertical', 'Vertical (V)'), c('parallel', 'Parallel'), c('perpendicular', 'Perpend.'), c('equal', 'Equal', 'Equal (E)'), c('tangent', 'Tangent', 'Tangent (T)'), c('midpoint', 'Midpoint'), c('symmetric', 'Symmetric'), c('concentric', 'Concentric'), c('fix', 'Fix', 'Fix / unfix')] },
        { group: 'Edit', items: [{ id: 'undo', label: 'Undo', icon: 'undo', run: () => this.undo(), enabled: () => this.store.canUndo() }, { id: 'redo', label: 'Redo', icon: 'redo', run: () => this.redo(), enabled: () => this.store.canRedo() }, { id: 'look', label: 'Look At', icon: 'lookat', run: () => this.lookAtSketch() }] },
        { group: 'Finish', items: [{ id: 'finish', label: 'Finish Sketch', icon: 'finish', cls: 'finish', run: () => this.exitSketch() }] },
      ];
    }
    if (this.tab === 'file') {
      return [
        { group: 'Project', items: [
          { id: 'new', label: 'New', icon: 'new', run: () => this.newDocument() },
          { id: 'open', label: 'Open', icon: 'open', run: () => this.openDocument(), title: 'Open (Ctrl+O)' },
          { id: 'save', label: 'Save', icon: 'save', run: () => this.saveDocument(), title: 'Save (Ctrl+S)' },
        ] },
        { group: 'Export Model', items: [
          { id: 'stl', label: 'STL', icon: 'export', run: () => this.exportMesh('stl'), title: 'Binary STL for 3D printing' },
          { id: 'obj', label: 'OBJ', icon: 'export', run: () => this.exportMesh('obj') },
          { id: 'glb', label: 'GLB', icon: 'export', run: () => this.exportMesh('glb'), title: 'glTF binary' },
          { id: 'png', label: 'Image', icon: 'image', run: () => download(`${this.store.doc.name}.png`, dataUrlToBlob(this.vp.screenshot()), 'image/png') },
        ] },
        { group: 'Export Sketch', items: [
          { id: 'dxf', label: 'DXF', icon: 'export', run: () => this.exportSketch('dxf'), title: 'Export selected sketch as DXF' },
          { id: 'svg', label: 'SVG', icon: 'export', run: () => this.exportSketch('svg'), title: 'Export selected sketch as SVG' },
        ] },
        { group: 'Help', items: [{ id: 'help', label: 'Shortcuts', icon: 'help', run: () => this.showHelp() }] },
      ];
    }
    if (this.tab === 'view') {
      return [
        { group: 'Orientation', items: [
          { id: 'iso', label: 'Home', icon: 'iso', run: () => this.view('iso') },
          { id: 'front', label: 'Front', icon: 'front', run: () => this.view('front') },
          { id: 'top', label: 'Top', icon: 'top', run: () => this.view('top') },
          { id: 'right', label: 'Right', icon: 'right', run: () => this.view('right') },
          { id: 'fit', label: 'Fit All', icon: 'fit', run: () => this.vp.fitAll(), title: 'Fit (F)' },
        ] },
        { group: 'Display', items: [
          { id: 'ortho', label: 'Orthographic', icon: 'ortho', run: () => this.toggleProjection(), active: () => this.vp.isOrtho },
          { id: 'grid', label: 'Grid', icon: 'grid', run: () => { this.vp.grid.visible = !this.vp.grid.visible; this.renderRibbonState(); }, active: () => this.vp.grid.visible },
          { id: 'sk', label: 'Sketches', icon: 'sketch', run: () => { this.showSketches = !this.showSketches; this.refreshSketchDisplay(); this.renderRibbonState(); }, active: () => this.showSketches },
        ] },
      ];
    }
    const sel = () => [...this.vp.selectedBodies];
    return [
      { group: 'Create', items: [
        { id: 'sketch', label: 'Sketch', icon: 'sketch', cls: 'primary', run: () => this.startNewSketch(), title: 'New sketch (S)' },
        { id: 'extrude', label: 'Extrude', icon: 'extrude', run: () => this.addExtrude(), title: 'Extrude (E)' },
        { id: 'revolve', label: 'Revolve', icon: 'revolve', run: () => this.addRevolve() },
        { id: 'box', label: 'Box', icon: 'box', run: () => this.addPrimitive('box') },
        { id: 'cyl', label: 'Cylinder', icon: 'cylinder', run: () => this.addPrimitive('cylinder') },
        { id: 'sph', label: 'Sphere', icon: 'sphere', run: () => this.addPrimitive('sphere') },
        { id: 'cone', label: 'Cone', icon: 'cone', run: () => this.addPrimitive('cone') },
        { id: 'torus', label: 'Torus', icon: 'torus', run: () => this.addPrimitive('torus') },
      ] },
      { group: 'Modify', items: [
        { id: 'combine', label: 'Combine', icon: 'combine', run: () => this.addBoolean(), title: 'Boolean union / subtract / intersect' },
        { id: 'move', label: 'Move/Copy', icon: 'move', run: () => this.addTransform(), title: 'Move (M)' },
        { id: 'lpat', label: 'Pattern', icon: 'pattern', run: () => this.addPattern('linear') },
        { id: 'cpat', label: 'Circular', icon: 'circpattern', run: () => this.addPattern('circular') },
        { id: 'mirror', label: 'Mirror', icon: 'mirror', run: () => this.addMirror() },
        { id: 'delete', label: 'Delete', icon: 'delete', run: () => this.deleteSelected(), enabled: () => !!this.selectedFeature || sel().length > 0 },
      ] },
      { group: 'Inspect', items: [
        { id: 'measure', label: 'Measure', icon: 'measure', run: () => this.toggleMeasure(), active: () => this.mode === 'measure' },
      ] },
      { group: 'Edit', items: [
        { id: 'undo', label: 'Undo', icon: 'undo', run: () => this.undo(), enabled: () => this.store.canUndo(), title: 'Undo (Ctrl+Z)' },
        { id: 'redo', label: 'Redo', icon: 'redo', run: () => this.redo(), enabled: () => this.store.canRedo(), title: 'Redo (Ctrl+Y)' },
      ] },
    ];
  }

  private btnIndex = new Map<string, { b: Btn; el: HTMLButtonElement }>();

  renderRibbon() {
    const tabs = document.getElementById('ribbon-tabs')!;
    if (this.mode === 'sketch') {
      tabs.innerHTML = `<button class="active">Sketch</button>`;
    } else {
      tabs.innerHTML = (['file', 'model', 'view'] as RibbonTab[])
        .map((t) => `<button data-t="${t}" class="${t === this.tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`)
        .join('');
      tabs.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          this.tab = (b as HTMLElement).dataset.t as RibbonTab;
          this.renderRibbon();
        }),
      );
    }
    const rib = document.getElementById('ribbon')!;
    rib.innerHTML = '';
    this.btnIndex.clear();
    for (const g of this.ribbonButtons()) {
      const gEl = document.createElement('div');
      gEl.className = 'rgroup';
      const items = document.createElement('div');
      items.className = 'rgroup-items';
      for (const b of g.items) {
        const el = document.createElement('button');
        el.className = 'rbtn ' + (b.cls ?? '');
        el.innerHTML = `${icon(b.icon)}<span>${b.label}</span>`;
        el.title = b.title ?? b.label;
        el.addEventListener('click', () => b.run());
        items.appendChild(el);
        this.btnIndex.set(b.id, { b, el });
      }
      gEl.appendChild(items);
      const lab = document.createElement('div');
      lab.className = 'rgroup-label';
      lab.textContent = g.group;
      gEl.appendChild(lab);
      rib.appendChild(gEl);
    }
    this.renderRibbonState();
  }

  renderRibbonState() {
    for (const { b, el } of this.btnIndex.values()) {
      el.classList.toggle('active', !!b.active?.());
      el.disabled = b.enabled ? !b.enabled() : false;
    }
    const pb = document.querySelector<HTMLButtonElement>('#view-buttons [data-v=proj]');
    if (pb) pb.textContent = this.vp.isOrtho ? 'Perspective' : 'Ortho';
  }

  // ============================================================ status bar

  renderStatus() {
    const sb = document.getElementById('statusbar')!;
    if (!sb.dataset.built) {
      sb.dataset.built = '1';
      sb.innerHTML = `
        <span class="coords" id="sb-coords">—</span>
        <button class="toggle" id="sb-grid" title="Snap to grid (G)">Grid snap</button>
        <label>Step <input id="sb-step" type="text"></label>
        <button class="toggle" id="sb-obj" title="Snap to geometry">Object snap</button>
        <span class="dof" id="sb-dof"></span>
        <span class="msg" id="sb-msg"></span>
        <span id="sb-info"></span>`;
      sb.querySelector('#sb-grid')!.addEventListener('click', () => { this.settings.snapGrid = !this.settings.snapGrid; this.renderStatus(); });
      sb.querySelector('#sb-obj')!.addEventListener('click', () => { this.settings.snapObjects = !this.settings.snapObjects; this.renderStatus(); });
      const step = sb.querySelector<HTMLInputElement>('#sb-step')!;
      step.addEventListener('change', () => {
        const v = this.scope().tryEval(step.value).value;
        if (v && v > 0) this.settings.gridStep = v;
        this.renderStatus();
        this.updateGridForMode();
      });
    }
    sb.querySelector('#sb-grid')!.classList.toggle('on', this.settings.snapGrid);
    sb.querySelector('#sb-obj')!.classList.toggle('on', this.settings.snapObjects);
    const step = sb.querySelector<HTMLInputElement>('#sb-step')!;
    if (document.activeElement !== step) step.value = String(this.settings.gridStep);
    const dof = sb.querySelector<HTMLElement>('#sb-dof')!;
    if (this.editor && this.editor.lastSolve) {
      const r = this.editor.lastSolve;
      const conflicts = r.conflicting.length + r.redundant.length;
      dof.className = 'dof ' + (!r.ok || conflicts ? 'over' : r.dof === 0 ? 'full' : 'under');
      dof.textContent = !r.ok ? 'Solve failed' : conflicts ? `Over-constrained (${conflicts})` : r.dof === 0 ? 'Fully constrained' : `DOF: ${r.dof}`;
    } else dof.textContent = '';
    sb.querySelector('#sb-msg')!.textContent = this.statusMsg;
    const info = sb.querySelector('#sb-info')!;
    if (this.result) {
      const tri = this.result.bodies.reduce((a, b) => a + b.triangles, 0);
      info.textContent = `${this.result.bodies.length} bodies · ${tri.toLocaleString()} tris · ${this.result.timeMs.toFixed(0)} ms`;
    }
  }

  status(msg: string) {
    this.statusMsg = msg;
    const el = document.getElementById('sb-msg');
    if (el) el.textContent = msg;
  }

  toast(msg: string, kind: 'ok' | 'err' | '' = '') {
    const host = document.getElementById('toast-host')!;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 3600);
  }

  private setCoords(text: string) {
    const el = document.getElementById('sb-coords');
    if (el) el.textContent = text;
  }

  // ============================================================ pointer handling

  private onPointerDown(e: PointerEvent) {
    if (this.gizmo?.dragging || (this.gizmo?.enabled && this.gizmo.axis)) return;
    if (this.mode === 'sketch') return this.editor?.onPointerDown(e);
    if (e.button !== 0) return;
    if (this.mode === 'pickPlane') {
      const plane = this.vp.pickPlane(e);
      const hit = this.vp.pickBody(e);
      if (hit && hit.planar) {
        const frame = frameFromPlane([hit.point.x, hit.point.y, hit.point.z], [hit.normal.x, hit.normal.y, hit.normal.z]);
        const body = this.result?.bodies.find((b) => b.id === hit.bodyId);
        this.createSketch({ kind: 'custom', frame, label: `Face of ${body?.name ?? 'body'}`, offset: '0' });
      } else if (plane) {
        this.createSketch({ kind: 'origin', plane: plane as OriginPlane, offset: '0' });
      } else if (hit && !hit.planar) {
        this.toast('That face is not planar', 'err');
      }
      return;
    }
    if (this.mode === 'measure') return this.measureClick(e);
    // model selection
    const hit = this.vp.pickBody(e);
    if (hit) {
      if (e.shiftKey || e.ctrlKey) {
        if (this.vp.selectedBodies.has(hit.bodyId)) this.vp.selectedBodies.delete(hit.bodyId);
        else this.vp.selectedBodies.add(hit.bodyId);
      } else {
        this.vp.selectedBodies.clear();
        this.vp.selectedBodies.add(hit.bodyId);
        this.selectedFeature = null;
      }
    } else if (!e.shiftKey && !e.ctrlKey) {
      this.vp.selectedBodies.clear();
    }
    this.vp.refreshBodyColors();
    this.renderPanels();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.mode === 'sketch' && this.editor) {
      this.editor.onPointerMove(e);
      const m = this.editor.mouseLocal;
      this.setCoords(`x ${fmt(m[0], 2)}   y ${fmt(m[1], 2)}  mm`);
      return;
    }
    const hit = this.vp.pickBody(e);
    if (this.mode === 'pickPlane') {
      this.vp.highlightFace(hit && hit.planar ? hit : null);
    } else if (this.mode === 'measure') {
      this.measureHover(e, hit);
    } else {
      const id = hit?.bodyId ?? null;
      if (id !== this.vp.hoverBody) {
        this.vp.hoverBody = id;
        this.vp.refreshBodyColors();
      }
    }
    if (hit) this.setCoords(`X ${fmt(hit.point.x, 2)}  Y ${fmt(hit.point.y, 2)}  Z ${fmt(hit.point.z, 2)}`);
    else this.setCoords('—');
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.mode === 'sketch') return this.editor?.onDoubleClick(e);
    if (this.mode !== 'model') return;
    const hit = this.vp.pickBody(e);
    if (hit) {
      const body = this.result?.bodies.find((b) => b.id === hit.bodyId);
      if (body) this.selectFeature(body.featureId);
    }
  }

  // ============================================================ keyboard

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); return this.redo(); }
    if (ctrl && k === 's') { e.preventDefault(); return this.saveDocument(); }
    if (ctrl && k === 'o') { e.preventDefault(); return void this.openDocument(); }
    if (ctrl && k === 'a' && this.editor) { e.preventDefault(); return this.editor.selectAll(); }
    if (ctrl) return;

    if (this.mode === 'sketch' && this.editor) {
      const ed = this.editor;
      if (/^[0-9.\-]$/.test(e.key) && this.numeric.fields.length && ed.tool !== 'select') {
        e.preventDefault();
        this.numeric.show(...this.numericPos());
        this.numeric.focusWith(e.key);
        return;
      }
      if (e.key === 'Tab' && this.numeric.fields.length) {
        e.preventDefault();
        this.numeric.focusFirst();
        return;
      }
      const map: Record<string, () => void> = {
        escape: () => ed.escape(),
        delete: () => ed.deleteSelection(),
        backspace: () => ed.deleteSelection(),
        l: () => ed.setTool('line'),
        r: () => ed.setTool('rect'),
        c: () => ed.setTool('circle'),
        a: () => ed.setTool('arc'),
        p: () => ed.setTool('point'),
        d: () => ed.setTool('dimension'),
        x: () => ed.applyConstraint('construction'),
        h: () => ed.applyConstraint('horizontal'),
        v: () => ed.applyConstraint('vertical'),
        e: () => ed.applyConstraint('equal'),
        t: () => ed.applyConstraint('tangent'),
        g: () => { this.settings.snapGrid = !this.settings.snapGrid; this.renderStatus(); },
        f: () => this.vp.fitAll(),
      };
      if (map[k]) {
        e.preventDefault();
        map[k]();
        this.renderRibbonState();
      }
      return;
    }

    const map: Record<string, () => void> = {
      escape: () => this.escape(),
      delete: () => this.deleteSelected(),
      backspace: () => this.deleteSelected(),
      s: () => this.startNewSketch(),
      e: () => this.addExtrude(),
      m: () => this.addTransform(),
      f: () => this.vp.fitAll(),
      g: () => { this.settings.snapGrid = !this.settings.snapGrid; this.renderStatus(); },
      '1': () => this.view('front'),
      '2': () => this.view('top'),
      '3': () => this.view('right'),
      '0': () => this.view('iso'),
      '5': () => this.toggleProjection(),
    };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    }
  }

  private numericPos(): [number, number] {
    const el = document.getElementById('numeric-input')!;
    return [parseFloat(el.style.left || '200') - 18, parseFloat(el.style.top || '200') - 18];
  }

  escape() {
    if (this.mode === 'pickPlane' || this.mode === 'measure') return this.setMode('model');
    if (this.vp.selectedBodies.size || this.selectedFeature) {
      this.vp.selectedBodies.clear();
      this.selectedFeature = null;
      this.vp.refreshBodyColors();
      this.renderPanels();
    }
  }

  // ============================================================ modes

  setMode(m: Mode) {
    if (this.mode === 'measure' && m !== 'measure') this.clearMeasure();
    this.mode = m;
    this.vp.showOriginPlanes(m === 'pickPlane');
    this.vp.highlightFace(null);
    const banner = document.getElementById('sketch-banner')!;
    banner.classList.toggle('hidden', m === 'model');
    if (m === 'pickPlane') banner.textContent = 'Select a plane or a planar face for the new sketch · Esc to cancel';
    if (m === 'measure') banner.textContent = 'Measure: click two points (vertices snap) · Esc to exit';
    if (m === 'model') this.status('');
    this.renderRibbonState();
  }

  view(name: 'iso' | 'front' | 'top' | 'right') {
    const dirs: Record<string, Vec3> = { iso: [1, -1.2, 0.9], front: [0, -1, 0], top: [0, 0, 1], right: [1, 0, 0] };
    this.vp.setView(new THREE.Vector3(...dirs[name]));
  }

  toggleProjection() {
    this.vp.setProjection(!this.vp.isOrtho);
    if (this.gizmo) this.gizmo.camera = this.vp.camera;
    this.renderRibbonState();
  }

  // ============================================================ sketch mode

  startNewSketch() {
    if (this.mode === 'sketch') return;
    this.setMode('pickPlane');
  }

  private createSketch(plane: SketchFeature['plane']) {
    let id = '';
    this.store.commit('add-sketch', (doc) => {
      id = this.store.newId('s');
      const s: SketchFeature = {
        id, type: 'sketch', name: this.store.nextName('sketch'), plane,
        points: [{ id: ORIGIN_ID, x: 0, y: 0, fixed: true }], curves: [], constraints: [],
      };
      this.store.insertFeature(doc, s);
    });
    this.regen();
    this.enterSketch(id, true);
  }

  enterSketch(id: string, lookAt = false) {
    if (this.editor) this.exitSketch();
    if (!this.result) this.regen();
    const s = this.store.sketch(id);
    if (!s) return;
    if (this.store.isRolledBack(id)) {
      this.toast('Roll forward before editing this sketch', 'err');
      return;
    }
    if (!this.result!.frames.has(id)) this.regen();
    const frame = this.result!.frames.get(id);
    if (!frame) {
      this.toast('Sketch is suppressed', 'err');
      return;
    }
    this.setMode('sketch');
    document.getElementById('sketch-banner')!.textContent = `Editing ${s.name}`;
    document.getElementById('sketch-banner')!.classList.remove('hidden');
    this.selectedFeature = id;
    this.vp.selectedBodies.clear();
    this.vp.setBodyOpacity(0.35);
    this.editor = new SketchEditor(
      {
        store: this.store,
        vp: this.vp,
        numeric: this.numeric,
        scope: () => this.scope(),
        toast: (m, k) => this.toast(m, k),
        status: (m) => this.status(m),
        onSketchState: () => this.renderStatus(),
        onSelection: () => renderProps(this, document.getElementById('props-panel')!),
        settings: this.settings,
      },
      id,
      frame,
    );
    this.refreshSketchDisplay();
    this.updateGridForMode();
    this.renderRibbon();
    this.editor.setTool('line');
    this.renderPanels();
    if (lookAt) this.lookAtSketch();
  }

  exitSketch() {
    if (!this.editor) return;
    this.editor.dispose();
    this.editor = null;
    this.vp.setBodyOpacity(1);
    this.setMode('model');
    this.updateGridForMode();
    this.renderRibbon();
    this.regen();
  }

  lookAtSketch() {
    const id = this.editor?.id ?? this.selectedFeature;
    const f = id ? this.result?.frames.get(id) : undefined;
    if (!f) return;
    this.vp.setView(new THREE.Vector3(...f.z), new THREE.Vector3(...f.y));
  }

  private updateGridForMode() {
    const step = this.settings.gridStep;
    const major = step * 10;
    const size = Math.max(200, major * 20);
    const frame = this.editor ? this.editor.frame : undefined;
    const visible = this.vp.grid.visible;
    this.vp.setGrid(size, major, frame);
    this.vp.grid.visible = visible;
  }

  // ============================================================ feature creation

  private lastActiveSketch(): SketchFeature | undefined {
    const sel = this.selectedFeature ? this.store.sketch(this.selectedFeature) : undefined;
    if (sel && !this.store.isRolledBack(sel.id)) return sel;
    return [...this.store.activeFeatures()].reverse().find((f): f is SketchFeature => f.type === 'sketch' && !f.suppressed);
  }

  private addFeature(f: Feature) {
    this.store.commit('add-feature', (doc) => this.store.insertFeature(doc, f));
    this.selectFeature(f.id);
  }

  private defaultOp(): BodyOp {
    return (this.result?.bodies.length ?? 0) > 0 ? 'join' : 'new';
  }

  addExtrude() {
    if (this.mode === 'sketch') this.exitSketch();
    const s = this.lastActiveSketch();
    if (!s) return this.toast('Create a sketch with a closed profile first', 'err');
    this.addFeature({ id: this.store.newId('f'), type: 'extrude', name: this.store.nextName('extrude'), sketch: s.id, distance: '10', direction: 'normal', op: this.defaultOp(), target: 'auto' });
  }

  addRevolve() {
    if (this.mode === 'sketch') this.exitSketch();
    const s = this.lastActiveSketch();
    if (!s) return this.toast('Create a sketch first', 'err');
    const axisLine = s.curves.find((c) => c.type === 'line' && c.construction);
    this.addFeature({ id: this.store.newId('f'), type: 'revolve', name: this.store.nextName('revolve'), sketch: s.id, axis: axisLine?.id ?? 'Y', angle: '360', op: this.defaultOp(), target: 'auto' });
  }

  addPrimitive(shape: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus') {
    const size: Record<string, [string, string, string]> = {
      box: ['20', '20', '20'], cylinder: ['10', '20', ''], sphere: ['10', '', ''], cone: ['10', '0', '20'], torus: ['15', '4', ''],
    };
    this.addFeature({
      id: this.store.newId('f'), type: 'primitive', name: shape[0].toUpperCase() + shape.slice(1) + (this.store.doc.features.filter((f) => f.type === 'primitive').length + 1),
      shape, size: size[shape], position: ['0', '0', '0'], rotation: ['0', '0', '0'], centered: shape !== 'box', op: 'new', target: 'auto',
    });
  }

  private bodyIds(): string[] {
    return this.result?.bodies.map((b) => b.id) ?? [];
  }

  addBoolean() {
    const sel = [...this.vp.selectedBodies];
    const all = this.bodyIds();
    if (all.length < 2) return this.toast('Combine needs at least two bodies', 'err');
    const target = sel[0] ?? all[0];
    const tools = sel.length > 1 ? sel.slice(1) : all.filter((b) => b !== target);
    this.addFeature({ id: this.store.newId('f'), type: 'boolean', name: this.store.nextName('boolean'), op: 'union', target, tools, keepTools: false });
  }

  addTransform() {
    const bodies = this.vp.selectedBodies.size ? [...this.vp.selectedBodies] : this.bodyIds().slice(-1);
    if (!bodies.length) return this.toast('There are no bodies to move', 'err');
    this.addFeature({ id: this.store.newId('f'), type: 'transform', name: this.store.nextName('transform'), bodies, translate: ['0', '0', '0'], rotate: ['0', '0', '0'], scale: '1', copy: false });
  }

  addPattern(kind: 'linear' | 'circular') {
    const bodies = this.vp.selectedBodies.size ? [...this.vp.selectedBodies] : this.bodyIds().slice(-1);
    if (!bodies.length) return this.toast('There are no bodies to pattern', 'err');
    this.addFeature({
      id: this.store.newId('f'), type: 'pattern', name: this.store.nextName('pattern'), kind, bodies,
      count: kind === 'linear' ? '3' : '6', axis: kind === 'linear' ? 'X' : 'Z', spacing: kind === 'linear' ? '30' : '360',
      center: ['0', '0', '0'], count2: '1', axis2: 'Y', spacing2: '30', merge: false,
    });
  }

  addMirror() {
    const bodies = this.vp.selectedBodies.size ? [...this.vp.selectedBodies] : this.bodyIds().slice(-1);
    if (!bodies.length) return this.toast('There are no bodies to mirror', 'err');
    this.addFeature({ id: this.store.newId('f'), type: 'mirror', name: this.store.nextName('mirror'), bodies, plane: 'YZ', offset: '0', merge: true });
  }

  // ============================================================ feature management

  selectFeature(id: string | null) {
    this.selectedFeature = id;
    this.vp.selectedBodies.clear();
    const f = id ? this.store.feature(id) : null;
    if (f && 'bodies' in f) f.bodies.forEach((b) => this.vp.selectedBodies.add(b));
    this.vp.refreshBodyColors();
    this.renderPanels();
    this.updateGizmo();
  }

  updateFeature(id: string, mutate: (f: any) => void, reason = 'edit-feature') {
    this.store.commit(reason, (doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f) mutate(f);
    });
  }

  deleteFeature(id: string) {
    const f = this.store.feature(id);
    if (!f) return;
    const dependents = this.store.doc.features.filter((x) => (x.type === 'extrude' || x.type === 'revolve') && x.sketch === id);
    if (dependents.length && !confirm(`${f.name} is used by ${dependents.map((d) => d.name).join(', ')}. Delete it anyway?`)) return;
    if (this.editor?.id === id) this.exitSketch();
    this.store.commit('delete-feature', (doc) => {
      const idx = doc.features.findIndex((x) => x.id === id);
      doc.features.splice(idx, 1);
      if (doc.rollback !== null && idx < doc.rollback) doc.rollback--;
    });
    if (this.selectedFeature === id) this.selectedFeature = null;
  }

  deleteSelected() {
    if (this.selectedFeature) return this.deleteFeature(this.selectedFeature);
    const sel = [...this.vp.selectedBodies];
    if (!sel.length) return;
    // delete the features that created the selected bodies
    const feats = new Set(sel.map((b) => this.result?.bodies.find((x) => x.id === b)?.featureId).filter(Boolean) as string[]);
    if (!confirm(`Delete the feature(s) that created the selected bodies?`)) return;
    this.store.commit('delete-feature', (doc) => {
      doc.features = doc.features.filter((f) => !feats.has(f.id));
      if (doc.rollback !== null) doc.rollback = Math.min(doc.rollback, doc.features.length);
    });
    this.vp.selectedBodies.clear();
  }

  moveFeature(id: string, delta: number) {
    this.store.commit('reorder', (doc) => {
      const i = doc.features.findIndex((f) => f.id === id);
      const j = i + delta;
      if (j < 0 || j >= doc.features.length) return;
      [doc.features[i], doc.features[j]] = [doc.features[j], doc.features[i]];
    });
  }

  rollTo(index: number | null) {
    if (this.editor) this.exitSketch();
    this.store.commit('rollback', (doc) => {
      doc.rollback = index === null || index >= doc.features.length ? null : index;
    });
  }

  toggleBodyVisibility(id: string) {
    this.store.commit('visibility', (doc) => {
      const i = doc.hiddenBodies.indexOf(id);
      if (i >= 0) doc.hiddenBodies.splice(i, 1);
      else doc.hiddenBodies.push(id);
    });
  }

  selectBody(id: string, additive: boolean) {
    if (!additive) {
      this.vp.selectedBodies.clear();
      this.selectedFeature = null;
    }
    if (this.vp.selectedBodies.has(id)) this.vp.selectedBodies.delete(id);
    else this.vp.selectedBodies.add(id);
    this.vp.refreshBodyColors();
    this.renderPanels();
  }

  // ============================================================ gizmo for Move features

  updateGizmo() {
    const g = this.gizmo;
    if (!g) return;
    const f = this.selectedFeature ? this.store.feature(this.selectedFeature) : null;
    const show = this.mode === 'model' && f?.type === 'transform' && !f.suppressed && !this.store.isRolledBack(f.id) && !g.dragging;
    if (!show) {
      if (!g.dragging) {
        g.detach();
        g.enabled = false;
        g.getHelper().visible = false;
        this.gizmoFeature = null;
      }
      return;
    }
    if (g.dragging) return;
    const tf = f as Extract<Feature, { type: 'transform' }>;
    const sc = this.scope();
    const t = tf.translate.map((x) => sc.tryEval(x || '0').value ?? 0) as Vec3;
    // center of the moved bodies (as displayed)
    const box = new THREE.Box3();
    for (const id of tf.bodies) {
      const targetId = tf.copy ? `${tf.id}:${id}` : id;
      const m = this.vp.bodyMesh(targetId);
      if (m) box.expandByObject(m);
    }
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    this.gizmoTarget.position.copy(c);
    this.gizmoTarget.userData.base = c.clone().sub(new THREE.Vector3(...t));
    this.gizmoFeature = tf.id;
    g.attach(this.gizmoTarget);
    g.enabled = true;
    g.getHelper().visible = true;
    g.setMode('translate');
  }

  private onGizmoMove() {
    if (!this.gizmoFeature) return;
    const base = this.gizmoTarget.userData.base as THREE.Vector3;
    const d = this.gizmoTarget.position.clone().sub(base);
    const snap = this.settings.snapGrid ? this.settings.gridStep : 0;
    const r = (v: number) => fmt(snap ? Math.round(v / snap) * snap : v, 3);
    this.store.commit('gizmo', (doc) => {
      const f = doc.features.find((x) => x.id === this.gizmoFeature);
      if (f?.type === 'transform') f.translate = [r(d.x), r(d.y), r(d.z)];
    });
  }

  // ============================================================ measure

  toggleMeasure() {
    if (this.mode === 'sketch') return;
    this.setMode(this.mode === 'measure' ? 'model' : 'measure');
  }

  private measurePoint(e: MouseEvent, hit = this.vp.pickBody(e)): THREE.Vector3 | null {
    const v = this.vp.snapVertex(e, 12);
    if (v) return v;
    return hit?.point ?? null;
  }

  private measureHover(e: MouseEvent, hit: ReturnType<Viewport['pickBody']>) {
    const p = this.measurePoint(e, hit);
    this.drawMeasure(p);
  }

  private measureClick(e: MouseEvent) {
    const p = this.measurePoint(e);
    if (!p) return;
    if (this.measurePts.length >= 2) this.measurePts = [];
    this.measurePts.push(p);
    this.drawMeasure(null);
  }

  private drawMeasure(hover: THREE.Vector3 | null) {
    this.measureGroup.traverse((o) => (o as any).geometry?.dispose?.());
    this.measureGroup.clear();
    const pts = [...this.measurePts];
    if (hover && pts.length < 2) pts.push(hover);
    const mk = new THREE.MeshBasicMaterial({ color: 0x22c55e, depthTest: false });
    const px = this.vp.pixelSize(pts[0] ?? new THREE.Vector3());
    for (const p of pts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(px * 4), mk);
      s.position.copy(p);
      s.renderOrder = 50;
      this.measureGroup.add(s);
    }
    if (this.measureLabel) {
      this.measureLabel.remove();
      this.measureLabel = null;
    }
    if (pts.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false }));
      line.renderOrder = 50;
      this.measureGroup.add(line);
      const d = pts[1].clone().sub(pts[0]);
      const el = document.createElement('div');
      el.className = 'measure-label';
      el.textContent = `Distance ${fmt(d.length(), 3)} mm\nΔX ${fmt(d.x, 3)}  ΔY ${fmt(d.y, 3)}  ΔZ ${fmt(d.z, 3)}`;
      this.vp.labelLayer.appendChild(el);
      this.measureLabel = el;
      const mid = pts[0].clone().add(pts[1]).multiplyScalar(0.5);
      const place = () => {
        if (this.measureLabel !== el) return;
        const s = this.vp.toScreen(mid);
        if (s) Object.assign(el.style, { left: `${s.x}px`, top: `${s.y}px` });
        requestAnimationFrame(place);
      };
      place();
      this.status(`Distance: ${fmt(d.length(), 4)} mm`);
    }
  }

  private clearMeasure() {
    this.measurePts = [];
    this.drawMeasure(null);
  }

  // ============================================================ file ops

  undo() {
    if (this.editor && this.editor.cancelOp()) return;
    if (!this.store.undo()) this.toast('Nothing to undo');
    this.editor?.solve();
  }

  redo() {
    if (!this.store.redo()) this.toast('Nothing to redo');
    this.editor?.solve();
  }

  newDocument() {
    if (this.store.dirty && this.store.doc.features.length && !confirm('Discard the current model and start a new one?')) return;
    if (this.editor) this.exitSketch();
    this.selectedFeature = null;
    this.vp.selectedBodies.clear();
    this.store.replace(createEmptyDocument());
    this.vp.fitAll();
  }

  async openDocument() {
    try {
      const doc = await openProjectFile();
      if (!doc) return;
      if (this.editor) this.exitSketch();
      this.selectedFeature = null;
      this.vp.selectedBodies.clear();
      this.store.replace(doc);
      this.regen();
      this.vp.fitAll();
      this.toast(`Opened ${doc.name}`, 'ok');
    } catch (e) {
      this.toast(`Could not open file: ${(e as Error).message}`, 'err');
    }
  }

  saveDocument() {
    saveProject(clone(this.store.doc));
    this.store.dirty = false;
    this.renderPanels();
    this.toast('Project saved', 'ok');
  }

  async exportMesh(fmtName: 'stl' | 'obj' | 'glb') {
    try {
      const vis = (this.result?.bodies ?? []).filter((b) => !this.store.doc.hiddenBodies.includes(b.id));
      const chosen = this.vp.selectedBodies.size ? vis.filter((b) => this.vp.selectedBodies.has(b.id)) : vis;
      const bytes = await exportMesh(fmtName, chosen, this.store.doc.name);
      this.toast(`Exported ${chosen.length} body(ies) as ${fmtName.toUpperCase()} (${(bytes / 1024).toFixed(1)} KB)`, 'ok');
    } catch (e) {
      this.toast((e as Error).message, 'err');
    }
  }

  exportSketch(kind: 'dxf' | 'svg') {
    const id = this.editor?.id ?? this.selectedFeature;
    const s = id ? this.store.sketch(id) : this.lastActiveSketch();
    if (!s) return this.toast('Select a sketch in the browser first', 'err');
    if (kind === 'dxf') download(`${s.name}.dxf`, sketchToDXF(s), 'application/dxf');
    else download(`${s.name}.svg`, sketchToSVG(s), 'image/svg+xml');
    this.toast(`Exported ${s.name} as ${kind.toUpperCase()}`, 'ok');
  }

  showHelp() {
    const rows = [
      ['Right mouse drag', 'Orbit'], ['Middle mouse drag', 'Pan'], ['Mouse wheel', 'Zoom (to cursor)'],
      ['S', 'New sketch'], ['E', 'Extrude'], ['M', 'Move/Copy'], ['F', 'Fit all'], ['0 / 1 / 2 / 3', 'Home / Front / Top / Right view'], ['5', 'Toggle orthographic'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+S / Ctrl+O', 'Save / Open project'], ['Del', 'Delete selection'], ['Esc', 'Cancel / deselect'],
      ['— Sketch —', ''], ['L R C A P', 'Line, Rectangle, Circle, Arc, Point'], ['D', 'Dimension'], ['H / V / E / T', 'Horizontal / Vertical / Equal / Tangent'],
      ['X', 'Toggle construction'], ['G', 'Toggle grid snap'], ['Shift (while drawing)', 'Orthogonal line'], ['Type a number', 'Exact length / size (Tab switches fields, Enter confirms)'],
      ['Double-click dimension', 'Edit value (expressions & parameters allowed, e.g. width/2)'], ['Ctrl+A', 'Select all'],
    ];
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"><h2>OwnCAD – Controls</h2><table>${rows.map(([a, b]) => `<tr><td><kbd>${a}</kbd></td><td>${b}</td></tr>`).join('')}</table>
      <p style="color:var(--text-dim);line-height:1.5">Units are millimetres. All numeric fields accept expressions using parameters from the <b>Parameters</b> tab, e.g. <code>width * 2 + 5</code>, <code>1in</code>, <code>sqrt(2)*10</code>.</p>
      <div class="btn-row" style="padding:0"><button class="btn primary">Close</button></div></div>`;
    back.addEventListener('click', (e) => {
      if (e.target === back || (e.target as HTMLElement).tagName === 'BUTTON') back.remove();
    });
    document.body.appendChild(back);
  }

  /** Exposed for debugging / automated tests. */
  debugState() {
    return {
      features: this.store.doc.features.map((f) => ({ id: f.id, type: f.type, name: f.name })),
      bodies: this.result?.bodies.map((b) => ({ id: b.id, name: b.name, volume: b.volume, triangles: b.triangles, bbox: b.bbox })) ?? [],
      errors: Object.fromEntries(this.result?.errors ?? []),
      warnings: Object.fromEntries(this.result?.warnings ?? []),
      mode: this.mode,
      sketch: this.editor ? { id: this.editor.id, tool: this.editor.tool, solve: this.editor.lastSolve } : null,
    };
  }

  localOfWorld(p: Vec3): Vec3 | null {
    return this.editor ? toLocal(this.editor.frame, p) : null;
  }
}

function dataUrlToBlob(url: string): Blob {
  const [head, data] = url.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
