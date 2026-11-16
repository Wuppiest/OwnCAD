// Properties panel: edits the selected feature, sketch entity or shows body info.

import type { App } from '../app';
import type { Feature, SketchFeature } from '../model/types';
import { DIMENSION_TYPES } from '../model/types';
import { fmt } from '../model/expr';
import { escapeHtml } from './tree';
import { arcAngles, dist, P, pointMap } from '../sketch/geom';

type Opt = { value: string; label: string };

class Form {
  constructor(private el: HTMLElement, private app: App) {}

  section(title: string) {
    const d = document.createElement('div');
    d.className = 'props-section';
    d.textContent = title;
    this.el.appendChild(d);
  }

  info(html: string, cls = 'props-info') {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    this.el.appendChild(d);
  }

  private row(label: string): HTMLDivElement {
    const r = document.createElement('div');
    r.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);
    this.el.appendChild(r);
    return r;
  }

  expr(label: string, value: string, commit: (v: string) => void, opts: { unit?: string } = {}) {
    const r = this.row(label);
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value;
    inp.spellcheck = false;
    const val = document.createElement('div');
    val.className = 'val';
    const check = () => {
      const res = this.app.scope().tryEval(inp.value || '0');
      inp.classList.toggle('bad', res.error !== undefined);
      const isNum = !isNaN(Number(inp.value));
      val.textContent = res.error ?? (isNum ? '' : `= ${fmt(res.value!, 4)}${opts.unit ? ' ' + opts.unit : ''}`);
      return res.error === undefined;
    };
    check();
    inp.addEventListener('input', check);
    inp.addEventListener('change', () => {
      if (check() && inp.value !== value) commit(inp.value.trim());
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const n = Number(inp.value);
        if (!isNaN(n)) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          inp.value = fmt(n + (e.key === 'ArrowUp' ? step : -step), 4);
          check();
          commit(inp.value);
        }
      }
    });
    r.appendChild(inp);
    r.appendChild(val);
    return inp;
  }

  vec3(label: string, value: [string, string, string], commit: (v: [string, string, string]) => void) {
    const r = this.row(label);
    const wrap = document.createElement('div');
    wrap.className = 'row3';
    const inputs = value.map((v, i) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = v;
      inp.placeholder = 'XYZ'[i];
      inp.title = 'XYZ'[i];
      inp.addEventListener('change', () => {
        const ok = inputs.every((x) => this.app.scope().tryEval(x.value || '0').error === undefined);
        inputs.forEach((x) => x.classList.toggle('bad', this.app.scope().tryEval(x.value || '0').error !== undefined));
        if (ok) commit(inputs.map((x) => x.value.trim() || '0') as [string, string, string]);
      });
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
      wrap.appendChild(inp);
      return inp;
    });
    r.appendChild(wrap);
  }

  select(label: string, value: string, options: Opt[], commit: (v: string) => void) {
    const r = this.row(label);
    const s = document.createElement('select');
    for (const o of options) {
      const op = document.createElement('option');
      op.value = o.value;
      op.textContent = o.label;
      s.appendChild(op);
    }
    s.value = value;
    s.addEventListener('change', () => commit(s.value));
    r.appendChild(s);
  }

  check(label: string, value: boolean, commit: (v: boolean) => void) {
    const r = this.row(label);
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = value;
    c.style.justifySelf = 'start';
    c.addEventListener('change', () => commit(c.checked));
    r.appendChild(c);
  }

  multi(label: string, value: string[], options: Opt[], commit: (v: string[]) => void) {
    const r = this.row(label);
    const box = document.createElement('div');
    box.className = 'multi';
    if (!options.length) box.innerHTML = '<span style="color:var(--text-dim)">No bodies</span>';
    for (const o of options) {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = value.includes(o.value);
      c.addEventListener('change', () => {
        const set = new Set(value);
        if (c.checked) set.add(o.value);
        else set.delete(o.value);
        commit(options.map((x) => x.value).filter((x) => set.has(x)));
      });
      l.appendChild(c);
      l.append(o.label);
      box.appendChild(l);
    }
    r.appendChild(box);
  }

  buttons(btns: { label: string; run: () => void; primary?: boolean }[]) {
    const d = document.createElement('div');
    d.className = 'btn-row';
    for (const b of btns) {
      const e = document.createElement('button');
      e.className = 'btn' + (b.primary ? ' primary' : '');
      e.textContent = b.label;
      e.addEventListener('click', b.run);
      d.appendChild(e);
    }
    this.el.appendChild(d);
  }
}

const OPS = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];
const AXES = [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }];

export function renderProps(app: App, el: HTMLElement) {
  // keep focus if user is typing in the panel
  if (el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type === 'text') {
    return;
  }
  el.innerHTML = '';
  const form = new Form(el, app);
  const head = (kind: string, title: string) => {
    const h = document.createElement('div');
    h.className = 'props-head';
    h.innerHTML = `<div><div class="kind">${kind}</div><div class="title">${escapeHtml(title)}</div></div>`;
    el.appendChild(h);
  };

  if (app.editor) return renderSketchProps(app, el, form, head);

  const r = app.result;
  const fid = app.selectedFeature;
  const f = fid ? app.store.feature(fid) : null;

  if (!f) {
    const bodies = [...app.vp.selectedBodies].map((id) => r?.bodies.find((b) => b.id === id)).filter(Boolean);
    if (bodies.length) {
      for (const b of bodies) {
        head('Body', b!.name);
        const s = (v: number[]) => v.map((x) => fmt(x, 2)).join(', ');
        form.info(
          `Volume: <b>${fmt(b!.volume, 2)}</b> mm³<br>Surface area: <b>${fmt(b!.area, 2)}</b> mm²<br>` +
            `Size: <b>${s([0, 1, 2].map((i) => b!.bbox.max[i] - b!.bbox.min[i]))}</b> mm<br>Min: ${s(b!.bbox.min)}<br>Max: ${s(b!.bbox.max)}<br>Triangles: ${b!.triangles.toLocaleString()}` +
            `<br>Mass (PLA 1.24 g/cm³): ${fmt((b!.volume / 1000) * 1.24, 2)} g`,
        );
        form.buttons([{ label: 'Go to feature', run: () => app.selectFeature(b!.featureId) }]);
      }
      return;
    }
    head('Document', app.store.doc.name);
    form.info(
      `<b>Getting started</b><br>1. Click <b>Sketch</b> (S) and pick a plane.<br>2. Draw a closed shape — type numbers for exact sizes.<br>` +
        `3. Add dimensions (D) — use parameters like <code>width</code>.<br>4. <b>Finish Sketch</b>, then <b>Extrude</b> (E).<br>5. Sketch on a face of the body to add more features.<br><br>` +
        `<b>Mouse</b>: right-drag orbit · middle-drag pan · wheel zoom.`,
    );
    form.buttons([{ label: 'Keyboard shortcuts', run: () => app.showHelp() }]);
    return;
  }

  const err = r?.errors.get(f.id);
  const warn = r?.warnings.get(f.id);
  const kindName = { sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', primitive: 'Primitive', boolean: 'Combine', transform: 'Move / Copy', pattern: 'Pattern', mirror: 'Mirror' }[f.type];
  head(kindName, f.name);
  if (err) form.info(escapeHtml(err), 'props-error');
  else if (warn) form.info('⚠ ' + escapeHtml(warn));
  if (app.store.isRolledBack(f.id)) form.info('This feature is rolled back (inactive).');

  const upd = (mut: (x: any) => void) => app.updateFeature(f.id, mut);
  const idx = app.store.doc.features.indexOf(f);
  const prev = idx > 0 ? app.store.doc.features[idx - 1] : null;
  const bodiesBefore = (prev && r?.bodiesAfter.get(prev.id)) || [];
  const bodyOpts = bodiesBefore.map((b) => ({ value: b.id, label: b.name }));
  const targetOpts = [{ value: 'auto', label: 'Automatic' }, ...bodyOpts];
  const sketches = app.store.doc.features.slice(0, idx).filter((x): x is SketchFeature => x.type === 'sketch').map((s) => ({ value: s.id, label: s.name }));

  switch (f.type) {
    case 'sketch': {
      const plane = f.plane;
      form.info(`Plane: <b>${plane.kind === 'origin' ? plane.plane : escapeHtml(plane.label)}</b><br>${f.curves.length} curves · ${f.constraints.length} constraints`);
      const solve = r?.solves.get(f.id);
      if (solve) form.info(solve.ok ? (solve.dof === 0 ? '✔ Fully constrained' : `Degrees of freedom: ${solve.dof}`) : 'Sketch failed to solve');
      form.expr('Plane offset', plane.offset || '0', (v) => upd((x) => (x.plane.offset = v)), { unit: 'mm' });
      form.buttons([
        { label: 'Edit Sketch', primary: true, run: () => app.enterSketch(f.id) },
        { label: 'Extrude', run: () => app.addExtrude() },
        { label: 'Revolve', run: () => app.addRevolve() },
      ]);
      form.buttons([
        { label: 'Export DXF', run: () => app.exportSketch('dxf') },
        { label: 'Export SVG', run: () => app.exportSketch('svg') },
      ]);
      break;
    }
    case 'extrude': {
      form.select('Profile sketch', f.sketch, sketches, (v) => upd((x) => (x.sketch = v)));
      form.expr('Distance', f.distance, (v) => upd((x) => (x.distance = v)), { unit: 'mm' });
      form.select('Direction', f.direction, [{ value: 'normal', label: 'One side' }, { value: 'reverse', label: 'Reversed' }, { value: 'symmetric', label: 'Symmetric' }], (v) => upd((x) => (x.direction = v)));
      form.expr('Taper (scale)', f.taper ?? '1', (v) => upd((x) => (x.taper = v)));
      form.select('Operation', f.op, OPS, (v) => upd((x) => (x.op = v)));
      if (f.op !== 'new') form.select('Target body', f.target, targetOpts, (v) => upd((x) => (x.target = v)));
      break;
    }
    case 'revolve': {
      form.select('Profile sketch', f.sketch, sketches, (v) => upd((x) => (x.sketch = v)));
      const s = app.store.sketch(f.sketch);
      const lines = (s?.curves ?? []).filter((c) => c.type === 'line').map((c, i) => ({ value: c.id, label: `Line ${i + 1}${c.construction ? ' (construction)' : ''}` }));
      form.select('Axis', f.axis, [{ value: 'X', label: 'Sketch X axis' }, { value: 'Y', label: 'Sketch Y axis' }, ...lines], (v) => upd((x) => (x.axis = v)));
      form.expr('Angle', f.angle, (v) => upd((x) => (x.angle = v)), { unit: '°' });
      form.select('Operation', f.op, OPS, (v) => upd((x) => (x.op = v)));
      if (f.op !== 'new') form.select('Target body', f.target, targetOpts, (v) => upd((x) => (x.target = v)));
      form.info('Tip: draw a construction line in the sketch and choose it as the axis.');
      break;
    }
    case 'primitive': {
      const labels: Record<string, string[]> = {
        box: ['Length X', 'Width Y', 'Height Z'], cylinder: ['Radius', 'Height'], sphere: ['Radius'], cone: ['Bottom radius', 'Top radius', 'Height'], torus: ['Major radius', 'Minor radius'],
      };
      labels[f.shape].forEach((l, i) => form.expr(l, f.size[i] || '0', (v) => upd((x) => (x.size[i] = v)), { unit: 'mm' }));
      form.vec3('Position', f.position, (v) => upd((x) => (x.position = v)));
      form.vec3('Rotation °', f.rotation, (v) => upd((x) => (x.rotation = v)));
      if (f.shape !== 'sphere' && f.shape !== 'torus') form.check('Centered', f.centered, (v) => upd((x) => (x.centered = v)));
      form.select('Operation', f.op, OPS, (v) => upd((x) => (x.op = v)));
      if (f.op !== 'new') form.select('Target body', f.target, targetOpts, (v) => upd((x) => (x.target = v)));
      break;
    }
    case 'boolean': {
      form.select('Operation', f.op, [{ value: 'union', label: 'Join (union)' }, { value: 'subtract', label: 'Cut (subtract)' }, { value: 'intersect', label: 'Intersect' }], (v) => upd((x) => (x.op = v)));
      form.select('Target body', f.target, bodyOpts, (v) => upd((x) => (x.target = v)));
      form.multi('Tool bodies', f.tools, bodyOpts.filter((b) => b.value !== f.target), (v) => upd((x) => (x.tools = v)));
      form.check('Keep tools', f.keepTools, (v) => upd((x) => (x.keepTools = v)));
      break;
    }
    case 'transform': {
      form.multi('Bodies', f.bodies, bodyOpts, (v) => upd((x) => (x.bodies = v)));
      form.vec3('Translate', f.translate, (v) => upd((x) => (x.translate = v)));
      form.vec3('Rotate °', f.rotate, (v) => upd((x) => (x.rotate = v)));
      form.expr('Scale', f.scale, (v) => upd((x) => (x.scale = v)));
      form.check('Create copy', f.copy, (v) => upd((x) => (x.copy = v)));
      form.info('Drag the arrows in the viewport to move interactively.');
      break;
    }
    case 'pattern': {
      form.multi('Bodies', f.bodies, bodyOpts, (v) => upd((x) => (x.bodies = v)));
      form.expr('Count', f.count, (v) => upd((x) => (x.count = v)));
      if (f.kind === 'linear') {
        form.select('Direction', f.axis, AXES, (v) => upd((x) => (x.axis = v)));
        form.expr('Spacing', f.spacing, (v) => upd((x) => (x.spacing = v)), { unit: 'mm' });
        form.section('Second direction');
        form.expr('Count', f.count2 ?? '1', (v) => upd((x) => (x.count2 = v)));
        form.select('Direction', f.axis2 ?? 'Y', AXES, (v) => upd((x) => (x.axis2 = v)));
        form.expr('Spacing', f.spacing2 ?? '0', (v) => upd((x) => (x.spacing2 = v)), { unit: 'mm' });
      } else {
        form.select('Axis', f.axis, AXES, (v) => upd((x) => (x.axis = v)));
        form.expr('Total angle', f.spacing, (v) => upd((x) => (x.spacing = v)), { unit: '°' });
        form.vec3('Axis origin', f.center, (v) => upd((x) => (x.center = v)));
      }
      form.check('Merge into body', f.merge, (v) => upd((x) => (x.merge = v)));
      break;
    }
    case 'mirror': {
      form.multi('Bodies', f.bodies, bodyOpts, (v) => upd((x) => (x.bodies = v)));
      form.select('Mirror plane', f.plane, [{ value: 'YZ', label: 'YZ (mirror X)' }, { value: 'XZ', label: 'XZ (mirror Y)' }, { value: 'XY', label: 'XY (mirror Z)' }], (v) => upd((x) => (x.plane = v)));
      form.expr('Plane offset', f.offset, (v) => upd((x) => (x.offset = v)), { unit: 'mm' });
      form.check('Merge into body', f.merge, (v) => upd((x) => (x.merge = v)));
      break;
    }
  }

  form.section('Feature');
  form.check('Suppressed', !!f.suppressed, (v) => upd((x) => (x.suppressed = v)));
  form.buttons([
    { label: 'Delete', run: () => app.deleteFeature(f.id) },
    { label: 'Roll back here', run: () => app.rollTo(idx + 1) },
  ]);
  void ({} as Feature);
}

function renderSketchProps(app: App, el: HTMLElement, form: Form, head: (k: string, t: string) => void) {
  const ed = app.editor!;
  const s = ed.sketch;
  const pts = pointMap(s);
  const sel = [...ed.sel];
  const con = ed.selectedConstraint();
  if (con) {
    const isDim = DIMENSION_TYPES.includes(con.type);
    head(isDim ? 'Dimension' : 'Constraint', con.type);
    if (isDim) {
      const inp = form.expr('Value', con.value ?? '0', (v) => ed.setConstraintValue(con.id, v), { unit: con.type === 'angle' ? '°' : 'mm' });
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 0);
      form.check('Reference (driven)', !!con.reference, () => ed.toggleReference(con.id));
      form.info('Use parameters and expressions, e.g. <code>width/2</code>.');
    }
    form.buttons([{ label: 'Delete', run: () => ed.deleteSelection() }]);
    return;
  }
  if (sel.length === 1) {
    const id = sel[0];
    const p = pts.get(id);
    const c = s.curves.find((x) => x.id === id);
    if (p) {
      head('Point', id);
      form.info(`X: <b>${fmt(p.x, 3)}</b><br>Y: <b>${fmt(p.y, 3)}</b>`);
    } else if (c) {
      head(c.type === 'line' ? 'Line' : c.type === 'circle' ? 'Circle' : 'Arc', id);
      if (c.type === 'line') {
        const a = pts.get(c.p1)!, b = pts.get(c.p2)!;
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        form.info(`Length: <b>${fmt(dist(P(a), P(b)), 3)}</b><br>Angle: ${fmt(ang, 2)}°<br>Start: ${fmt(a.x)}, ${fmt(a.y)}<br>End: ${fmt(b.x)}, ${fmt(b.y)}`);
      } else if (c.type === 'circle') {
        const ctr = pts.get(c.c)!;
        form.info(`Radius: <b>${fmt(c.r, 3)}</b> · Diameter: ${fmt(c.r * 2, 3)}<br>Center: ${fmt(ctr.x)}, ${fmt(ctr.y)}`);
      } else {
        const { sweep } = arcAngles(c, pts);
        form.info(`Radius: <b>${fmt(c.r, 3)}</b><br>Sweep: ${fmt((sweep * 180) / Math.PI, 2)}°`);
      }
      form.check('Construction', !!c.construction, () => ed.applyConstraint('construction'));
    }
    const related = s.constraints.filter((k) => k.refs.includes(id));
    if (related.length) form.info('Constraints: ' + related.map((k) => k.type).join(', '));
    form.buttons([{ label: 'Delete', run: () => ed.deleteSelection() }]);
    return;
  }
  if (sel.length > 1) {
    head('Selection', `${sel.length} items`);
    form.info('Apply a constraint from the ribbon (Parallel, Equal, Tangent, …) or press Del to delete.');
    form.buttons([{ label: 'Delete', run: () => ed.deleteSelection() }]);
    return;
  }
  head('Sketch', s.name);
  const r = ed.lastSolve;
  form.info(
    `${s.curves.length} curves · ${s.points.length} points · ${s.constraints.length} constraints<br>` +
      (r ? (r.ok ? (r.dof === 0 ? '<b style="color:var(--ok)">Fully constrained</b>' : `Degrees of freedom: <b>${r.dof}</b>`) : '<b style="color:var(--err)">Solve failed</b>') : ''),
  );
  form.info(
    '<b>Tips</b><br>• Click near points/lines to snap; Shift = orthogonal.<br>• While drawing, just type a number for an exact length; Tab to switch fields.<br>' +
      '• Closed shapes are shaded blue — those are extrudable profiles.<br>• Double-click a dimension to edit it.',
  );
  form.buttons([{ label: 'Finish Sketch', primary: true, run: () => app.exitSketch() }]);
}
