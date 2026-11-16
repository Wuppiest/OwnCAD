// Small, safe expression evaluator for parametric values.
// Supports: numbers, + - * / ^ %, parentheses, unary minus, parameter names,
// constants (pi, e), functions (sin cos tan asin acos atan sqrt abs min max
// round floor ceil pow) with trig in degrees, and unit suffixes (mm cm m in deg rad).

import type { Expr, Parameter } from './types';

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

const UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E };
const D2R = Math.PI / 180;
const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (a) => Math.sin(a * D2R),
  cos: (a) => Math.cos(a * D2R),
  tan: (a) => Math.tan(a * D2R),
  asin: (a) => Math.asin(a) / D2R,
  acos: (a) => Math.acos(a) / D2R,
  atan: (a) => Math.atan(a) / D2R,
  atan2: (y, x) => Math.atan2(y, x) / D2R,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  pow: Math.pow,
};

export class ExprError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new ExprError(`Bad number at ${i}`);
      out.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^%(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new ExprError(`Unexpected '${c}'`);
  }
  return out;
}

export type Resolver = (name: string) => number;

/** Evaluate an expression string. Throws ExprError on failure. */
export function evaluate(src: string, resolve: Resolver = () => { throw new ExprError('Unknown name'); }): number {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}'`);
    p++;
  };

  function expr(): number {
    let v = term();
    while (isOp('+') || isOp('-')) {
      const o = toks[p++].v;
      const r = term();
      v = o === '+' ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const o = toks[p++].v;
      const r = unary();
      if (o === '*') v *= r;
      else if (o === '/') v /= r;
      else v %= r;
    }
    return v;
  }
  function unary(): number {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power(): number {
    const b = primary();
    if (isOp('^')) { p++; return Math.pow(b, unary()); }
    return b;
  }
  function primary(): number {
    const t = peek();
    if (!t) throw new ExprError('Unexpected end');
    if (t.t === 'num') {
      p++;
      let v = t.v;
      // unit suffix
      const n = peek();
      if (n && n.t === 'id' && n.v in UNITS) { p++; v *= UNITS[n.v]; }
      return v;
    }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new ExprError(`Unknown function '${t.v}'`);
        p++;
        const args: number[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { p++; args.push(expr()); }
        }
        expect(')');
        return fn(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      return resolve(t.v);
    }
    if (t.v === '(') {
      p++;
      const v = expr();
      expect(')');
      return v;
    }
    throw new ExprError(`Unexpected '${t.v}'`);
  }

  if (toks.length === 0) throw new ExprError('Empty expression');
  const v = expr();
  if (p < toks.length) throw new ExprError(`Unexpected '${toks[p].v}'`);
  if (!Number.isFinite(v)) throw new ExprError('Result is not a finite number');
  return v;
}

/** Names referenced by an expression (used for dependency checks). */
export function referencedNames(src: string): string[] {
  try {
    return tokenize(src)
      .map((t, i, a) => (t.t === 'id' && !(t.v in CONSTS) && !(t.v in UNITS && a[i - 1]?.t === 'num') && !(a[i + 1]?.t === 'op' && a[i + 1].v === '(') ? t.v : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

export const isValidParamName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !(n in CONSTS) && !(n in UNITS) && !(n in FUNCS);

/** Evaluates all parameters (which may reference each other). */
export class ParamScope {
  values = new Map<string, number>();
  errors = new Map<string, string>();

  constructor(params: Parameter[]) {
    const byName = new Map(params.map((p) => [p.name, p]));
    const visiting = new Set<string>();
    const resolveName = (name: string): number => {
      if (this.values.has(name)) return this.values.get(name)!;
      const p = byName.get(name);
      if (!p) throw new ExprError(`Unknown parameter '${name}'`);
      if (visiting.has(name)) throw new ExprError(`Circular reference via '${name}'`);
      visiting.add(name);
      try {
        const v = evaluate(p.expr, resolveName);
        this.values.set(name, v);
        return v;
      } finally {
        visiting.delete(name);
      }
    };
    for (const p of params) {
      try {
        resolveName(p.name);
      } catch (e) {
        this.errors.set(p.name, (e as Error).message);
      }
    }
  }

  /** Evaluate an expression in this scope. Throws on error. */
  eval(src: Expr): number {
    return evaluate(src, (n) => {
      if (this.values.has(n)) return this.values.get(n)!;
      throw new ExprError(this.errors.get(n) ?? `Unknown parameter '${n}'`);
    });
  }

  tryEval(src: Expr): { value?: number; error?: string } {
    try {
      return { value: this.eval(src) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}

/** Format a number for display. */
export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return (Object.is(r, -0) ? 0 : r).toString();
}
