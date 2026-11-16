// User parameter table.

import type { App } from '../app';
import { fmt, isValidParamName } from '../model/expr';

export function renderParams(app: App, el: HTMLElement) {
  if (el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
  const doc = app.store.doc;
  const scope = app.scope();
  el.innerHTML = `
    <div class="props-info">Parameters can be used in any numeric field and in sketch dimensions, e.g. <code>width / 2 + 3</code>. Changing a value rebuilds the model.</div>
    <table class="params-table">
      <thead><tr><th>Name</th><th>Expression</th><th>Value</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="btn-row"><button class="btn primary" id="param-add">+ Add parameter</button></div>`;
  const tb = el.querySelector('tbody')!;
  doc.params.forEach((p, i) => {
    const tr = document.createElement('tr');
    const err = scope.errors.get(p.name);
    tr.innerHTML = `<td><input class="pname" value="${p.name}"></td><td><input class="pexpr" value="${p.expr.replace(/"/g, '&quot;')}"></td>
      <td class="pval" title="${err ?? ''}">${err ? '⚠' : fmt(scope.values.get(p.name) ?? NaN, 3)}</td><td><button class="del" title="Delete">✕</button></td>`;
    const name = tr.querySelector<HTMLInputElement>('.pname')!;
    const expr = tr.querySelector<HTMLInputElement>('.pexpr')!;
    if (err) expr.classList.add('bad');
    name.addEventListener('change', () => {
      const n = name.value.trim();
      if (!isValidParamName(n) || doc.params.some((q, j) => j !== i && q.name === n)) {
        name.classList.add('bad');
        app.toast('Invalid or duplicate parameter name', 'err');
        return;
      }
      const old = p.name;
      app.store.commit('param', (d) => {
        d.params[i].name = n;
        // update references in other parameters
        const re = new RegExp(`\\b${old}\\b`, 'g');
        for (const q of d.params) q.expr = q.expr.replace(re, n);
        for (const f of d.features) renameRefs(f, re, n);
      });
    });
    expr.addEventListener('change', () => {
      app.store.commit('param', (d) => (d.params[i].expr = expr.value.trim() || '0'));
    });
    for (const inp of [name, expr]) inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
    tr.querySelector('.del')!.addEventListener('click', () => {
      app.store.commit('param', (d) => d.params.splice(i, 1));
    });
    tb.appendChild(tr);
  });
  el.querySelector('#param-add')!.addEventListener('click', () => {
    let n = 1;
    while (doc.params.some((p) => p.name === `p${n}`)) n++;
    app.store.commit('param', (d) => d.params.push({ name: `p${n}`, expr: '10' }));
  });
}

/** Replace parameter references inside all expression strings of a feature. */
function renameRefs(obj: any, re: RegExp, to: string) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && ['value', 'distance', 'angle', 'taper', 'count', 'spacing', 'count2', 'spacing2', 'scale', 'offset'].includes(k)) obj[k] = v.replace(re, to);
    else if (Array.isArray(v) && ['size', 'position', 'rotation', 'translate', 'rotate', 'center'].includes(k)) obj[k] = v.map((x: any) => (typeof x === 'string' ? x.replace(re, to) : x));
    else if (typeof v === 'object') renameRefs(v, re, to);
  }
}
