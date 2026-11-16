// Feature browser (history tree) and body list.

import type { App } from '../app';
import type { Feature } from '../model/types';
import { icon } from './icons';

const ICON: Record<Feature['type'], string> = {
  sketch: 'sketch', extrude: 'extrude', revolve: 'revolve', primitive: 'box', boolean: 'combine',
  transform: 'move', pattern: 'pattern', mirror: 'mirror',
};

function primitiveIcon(f: Feature) {
  if (f.type !== 'primitive') return ICON[f.type];
  return f.shape === 'box' ? 'box' : f.shape;
}

export function renderTree(app: App, el: HTMLElement) {
  const doc = app.store.doc;
  const r = app.result;
  el.innerHTML = '';

  // ---- bodies
  const bh = document.createElement('div');
  bh.className = 'tree-section';
  bh.innerHTML = `<span>Bodies (${r?.bodies.length ?? 0})</span>`;
  el.appendChild(bh);
  for (const b of r?.bodies ?? []) {
    const hidden = doc.hiddenBodies.includes(b.id);
    const it = document.createElement('div');
    it.className = 'tree-item' + (app.vp.selectedBodies.has(b.id) ? ' selected' : '');
    it.innerHTML = `${icon('body', 'ico')}<span class="name">${b.name}</span><button class="eye ${hidden ? 'off' : ''}" title="Show/hide">👁</button>`;
    it.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('eye')) return app.toggleBodyVisibility(b.id);
      app.selectBody(b.id, e.shiftKey || e.ctrlKey);
    });
    el.appendChild(it);
  }
  if (!r?.bodies.length) {
    const e = document.createElement('div');
    e.className = 'props-empty';
    e.style.padding = '4px 14px';
    e.textContent = 'No bodies yet.';
    el.appendChild(e);
  }

  // ---- history
  const hh = document.createElement('div');
  hh.className = 'tree-section';
  hh.innerHTML = `<span>History (${doc.features.length})</span><span class="spacer"></span>`;
  el.appendChild(hh);

  const origin = document.createElement('div');
  origin.className = 'tree-item';
  origin.innerHTML = `${icon('iso', 'ico')}<span class="name" style="color:var(--text-dim)">Origin (XY · XZ · YZ)</span>`;
  el.appendChild(origin);

  const rb = doc.rollback ?? doc.features.length;
  doc.features.forEach((f, i) => {
    if (i === rb) el.appendChild(rollbackBar(app));
    const it = document.createElement('div');
    const err = r?.errors.get(f.id);
    const warn = r?.warnings.get(f.id);
    it.className = 'tree-item' + (app.selectedFeature === f.id ? ' selected' : '') + (i >= rb ? ' rolled' : '') + (f.suppressed ? ' suppressed' : '') + (err ? ' error' : '');
    it.title = err ?? warn ?? '';
    const eye = f.type === 'sketch' ? `<button class="eye ${f.visible === false ? 'off' : ''}" title="Show/hide sketch">👁</button>` : '';
    it.innerHTML = `${icon(primitiveIcon(f), 'ico')}<span class="name">${escapeHtml(f.name)}</span>${err ? '<span class="badge">⚠</span>' : warn ? '<span class="badge" style="color:var(--warn)">!</span>' : ''}${eye}`;
    it.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('eye')) {
        app.updateFeature(f.id, (x) => (x.visible = x.visible === false ? true : false), 'visibility');
        return;
      }
      app.selectFeature(f.id);
    });
    it.addEventListener('dblclick', () => {
      if (f.type === 'sketch') app.enterSketch(f.id);
    });
    it.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      app.selectFeature(f.id);
      contextMenu(e.clientX, e.clientY, [
        ...(f.type === 'sketch' ? [{ label: 'Edit sketch', run: () => app.enterSketch(f.id) }] : []),
        { label: 'Rename', run: () => rename(app, it, f) },
        { label: f.suppressed ? 'Unsuppress' : 'Suppress', run: () => app.updateFeature(f.id, (x) => (x.suppressed = !x.suppressed)) },
        null,
        { label: 'Roll back to here', run: () => app.rollTo(i) },
        { label: 'Roll to end', run: () => app.rollTo(null) },
        null,
        { label: 'Move up', run: () => app.moveFeature(f.id, -1) },
        { label: 'Move down', run: () => app.moveFeature(f.id, 1) },
        null,
        { label: 'Delete', run: () => app.deleteFeature(f.id) },
      ]);
    });
    el.appendChild(it);
  });
  if (rb >= doc.features.length && doc.features.length) el.appendChild(rollbackBar(app));
  if (!doc.features.length) {
    const e = document.createElement('div');
    e.className = 'props-empty';
    e.innerHTML = 'Start with <b>Sketch</b> (S) and pick a plane, or add a primitive such as a <b>Box</b>.';
    el.appendChild(e);
  }
}

function rollbackBar(app: App) {
  const bar = document.createElement('div');
  bar.className = 'rollback-bar';
  bar.title = 'Rollback marker — right-click a feature to roll back to it, double-click here to roll to end';
  bar.addEventListener('dblclick', () => app.rollTo(null));
  return bar;
}

function rename(app: App, it: HTMLElement, f: Feature) {
  const name = it.querySelector('.name') as HTMLElement;
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.value = f.name;
  name.replaceWith(inp);
  inp.focus();
  inp.select();
  const done = (ok: boolean) => {
    if (ok && inp.value.trim()) app.updateFeature(f.id, (x) => (x.name = inp.value.trim()), 'rename');
    else app.renderPanels();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  inp.addEventListener('blur', () => done(true));
}

export function contextMenu(x: number, y: number, items: ({ label: string; run: () => void } | null)[]) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  for (const it of items) {
    if (!it) {
      m.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.addEventListener('click', () => {
      m.remove();
      it.run();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  setTimeout(() => window.addEventListener('pointerdown', function close(e) {
    if (!m.contains(e.target as Node)) {
      m.remove();
      window.removeEventListener('pointerdown', close);
    }
  }), 0);
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
