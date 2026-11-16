import { describe, expect, it } from 'vitest';
import { evaluate, ParamScope } from '../src/model/expr';
import { findProfiles } from '../src/sketch/profiles';
import { createEmptyDocument, parseDocument } from '../src/model/document';
import type { SketchFeature } from '../src/model/types';

describe('expressions', () => {
  it('evaluates arithmetic with precedence', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('10 % 4')).toBe(2);
  });
  it('supports units, constants and functions', () => {
    expect(evaluate('1in')).toBeCloseTo(25.4);
    expect(evaluate('2cm + 5mm')).toBe(25);
    expect(evaluate('sin(90)')).toBeCloseTo(1);
    expect(evaluate('max(1, 7, 3)')).toBe(7);
    expect(evaluate('pi')).toBeCloseTo(Math.PI);
  });
  it('rejects junk', () => {
    expect(() => evaluate('2 +')).toThrow();
    expect(() => evaluate('foo(1)')).toThrow();
    expect(() => evaluate('1/0')).toThrow();
    expect(() => evaluate('alert(1)')).toThrow();
  });
  it('resolves parameters with dependencies and detects cycles', () => {
    const s = new ParamScope([
      { name: 'b', expr: 'a * 2' },
      { name: 'a', expr: '5' },
      { name: 'x', expr: 'y + 1' },
      { name: 'y', expr: 'x + 1' },
    ]);
    expect(s.values.get('b')).toBe(10);
    expect(s.eval('a + b')).toBe(15);
    expect(s.errors.has('x')).toBe(true);
    expect(s.tryEval('x').error).toBeDefined();
  });
});

function sketch(points: [string, number, number][], lines: [string, string][], extra: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id: 's1', type: 'sketch', name: 'S', plane: { kind: 'origin', plane: 'XY', offset: '0' },
    points: points.map(([id, x, y]) => ({ id, x, y })),
    curves: lines.map(([a, b], i) => ({ id: `l${i}`, type: 'line' as const, p1: a, p2: b })),
    constraints: [],
    ...extra,
  };
}

const area = (poly: [number, number][]) => poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0) / 2;

describe('profiles', () => {
  it('finds a rectangle', () => {
    const s = sketch([['a', 0, 0], ['b', 40, 0], ['c', 40, 20], ['d', 0, 20]], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]);
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(area(r.loops[0])).toBeCloseTo(800);
    expect(r.openCurveIds).toEqual([]);
  });
  it('splits a rectangle divided by a line into two regions', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 20, 0], ['c', 40, 0], ['d', 40, 20], ['e', 20, 20], ['f', 0, 20]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'a'], ['b', 'e']],
    );
    const r = findProfiles(s);
    expect(r.loops.length).toBe(2);
    expect(r.loops.map(area).reduce((a, b) => a + b)).toBeCloseTo(800);
  });
  it('treats circles as loops and ignores construction and open curves', () => {
    const s = sketch([['a', 0, 0], ['b', 10, 0], ['o', 50, 50]], [['a', 'b']], {});
    s.curves.push({ id: 'k', type: 'circle', c: 'o', r: 5 });
    s.curves.push({ id: 'k2', type: 'circle', c: 'o', r: 8, construction: true });
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(r.openCurveIds).toEqual(['l0']);
  });
  it('handles a dangling edge inside a closed loop', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 10, 0], ['c', 10, 10], ['d', 0, 10], ['e', 5, 5]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'e']],
    );
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(Math.abs(area(r.loops[0]))).toBeCloseTo(100);
  });
});

describe('document', () => {
  it('round-trips through JSON', () => {
    const d = createEmptyDocument();
    d.features.push({ id: 'f1', type: 'primitive', name: 'Box1', shape: 'box', size: ['10', '10', '10'], position: ['0', '0', '0'], rotation: ['0', '0', '0'], centered: false, op: 'new', target: 'auto' });
    const back = parseDocument(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
  });
  it('rejects foreign files', () => {
    expect(() => parseDocument({ hello: 1 })).toThrow();
  });
});
