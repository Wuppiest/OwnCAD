// Floating numeric input shown next to the cursor while drawing.
// Typing locks a field; locked fields constrain the live preview; Enter commits.

export interface NumField {
  key: string;
  label: string;
  value: number;
  locked: boolean;
  text: string;
}

export class NumericInput {
  el: HTMLElement;
  fields: NumField[] = [];
  private inputs: HTMLInputElement[] = [];
  onCommit: (() => void) | null = null;
  onChange: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  private evalFn: (s: string) => number | undefined;

  constructor(el: HTMLElement, evalFn: (s: string) => number | undefined) {
    this.el = el;
    this.evalFn = evalFn;
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  get focused() {
    return this.inputs.some((i) => i === document.activeElement);
  }

  /** Configure fields for the current tool. Keeps lock state of fields with same key. */
  setFields(defs: { key: string; label: string }[]) {
    const old = new Map(this.fields.map((f) => [f.key, f]));
    const same = defs.length === this.fields.length && defs.every((d, i) => d.key === this.fields[i].key);
    this.fields = defs.map((d) => old.get(d.key) ?? { ...d, value: 0, locked: false, text: '' });
    if (!same) this.build();
  }

  private build() {
    this.el.innerHTML = '';
    this.inputs = this.fields.map((f, i) => {
      const lab = document.createElement('label');
      lab.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.spellcheck = false;
      inp.addEventListener('input', () => {
        f.text = inp.value;
        const v = this.evalFn(inp.value);
        f.locked = inp.value.trim() !== '' && v !== undefined;
        if (v !== undefined) f.value = v;
        inp.style.borderColor = inp.value.trim() && v === undefined ? 'var(--err)' : '';
        this.onChange?.();
      });
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onCommit?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.onCancel?.();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const n = this.inputs.length;
          this.inputs[(i + (e.shiftKey ? n - 1 : 1)) % n].focus();
          this.inputs[(i + (e.shiftKey ? n - 1 : 1)) % n].select();
        }
      });
      lab.appendChild(inp);
      this.el.appendChild(lab);
      return inp;
    });
  }

  show(x: number, y: number) {
    this.el.classList.remove('hidden');
    this.el.style.left = `${x + 18}px`;
    this.el.style.top = `${y + 18}px`;
  }

  hide() {
    this.el.classList.add('hidden');
    this.reset();
  }

  reset() {
    for (const f of this.fields) {
      f.locked = false;
      f.text = '';
    }
    this.inputs.forEach((i) => {
      i.value = '';
      i.style.borderColor = '';
    });
  }

  /** Update displayed live values for unlocked fields. */
  setLive(values: Record<string, number>) {
    this.fields.forEach((f, i) => {
      if (f.locked || values[f.key] === undefined) return;
      f.value = values[f.key];
      const inp = this.inputs[i];
      if (inp !== document.activeElement || !inp.value) inp.placeholder = (Math.round(f.value * 1000) / 1000).toString();
    });
  }

  get(key: string): NumField | undefined {
    return this.fields.find((f) => f.key === key);
  }

  /** Start typing into the first field (called when user presses a digit in the viewport). */
  focusWith(ch: string) {
    if (!this.inputs.length) return;
    const inp = this.inputs[0];
    inp.focus();
    inp.value = ch;
    inp.dispatchEvent(new Event('input'));
  }

  focusFirst() {
    this.inputs[0]?.focus();
    this.inputs[0]?.select();
  }
}
